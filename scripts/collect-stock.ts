/**
 * Stock reference-info collector (PLAN-DASHBOARD P0b). Fetches read-only market
 * data from KIS and POSTs normalized snapshots to the jarvis API. Designed to
 * run from GitHub Actions cron (post-close) — NOT inside Vercel.
 *
 * Env: KIS_APP_KEY, KIS_APP_SECRET, JARVIS_API_TOKEN, JARVIS_BASE_URL
 *   local:  pnpm collect:stock            (uses .env.local)
 *   CI:     tsx scripts/collect-stock.ts  (env from GitHub Secrets)
 *
 * Backfill mode — `--backfill[=N]` or STOCK_BACKFILL_DAYS=N (default 30 days).
 * Posts every trading day KIS still returns instead of just the latest one, so
 * the dashboard has history to trend over. Upsert is idempotent on
 * (symbol, source, metric, bucket_key), so re-running is safe. Days are posted
 * oldest-first, keeping captured_at monotonic with the trading date.
 */
import { randomUUID } from 'node:crypto';
import {
  currentQuote,
  dailyCandles,
  foreignHolding,
  investorFlows,
  issueToken,
  type KisCreds,
} from '../src/lib/kis-marketdata';
import { fetchDartDisclosures, fetchNewsHeadlines } from '../src/lib/market-sources';

const SYMBOL = process.env.STOCK_SYMBOL ?? '000660'; // SK hynix
const BASE = process.env.JARVIS_BASE_URL ?? 'http://localhost:3000';
const KST = 9 * 3600 * 1000;
// 이벤트 소스 파라미터. DART 고유번호는 종목코드와 다른 체계다 (SK하이닉스 = 00164779,
// corpCode.xml에서 확인). 종목을 바꾸면 이 둘도 같이 바꿔야 한다.
const CORP_CODE = process.env.DART_CORP_CODE ?? '00164779';
const NEWS_QUERY = process.env.NEWS_QUERY ?? 'SK하이닉스';

function ymd(kisDate: string): string {
  return `${kisDate.slice(0, 4)}-${kisDate.slice(4, 6)}-${kisDate.slice(6, 8)}`;
}
function kstDay(daysAgo = 0): { compact: string; dashed: string } {
  const s = new Date(Date.now() + KST - daysAgo * 86400000).toISOString().slice(0, 10);
  return { compact: s.replace(/-/g, ''), dashed: s };
}

// KRX 정규장 마감 15:30 + 종가단일가 정리. 이 시각 전에는 그날 일봉·수급이 확정이 아니다.
const SETTLE_HOUR_KST = 16;

/**
 * 오늘 값이 확정됐는지. 프리마켓 cron이 늦게 떠서 개장 뒤에 돌면 KIS가 **진행 중인
 * 부분 봉**을 오늘 일봉으로 돌려준다 (실제로 2026-07-30 09:09 실행이 9분치 봉을 저장했다).
 * 같은 자연키를 마감 수집이 덮어쓰긴 하지만, 그 사이 대시보드는 부분 봉을 종가로 보여주고
 * 마감 수집이 실패하면 그 값이 그날 일봉으로 남아버린다 — 그래서 아예 담지 않는다.
 */
function settledToday(): boolean {
  return new Date(Date.now() + KST).getUTCHours() >= SETTLE_HOUR_KST;
}

/** 정규장(평일 09:00~15:30 KST) 안인가. 장 밖 인트라데이 수집은 같은 값의 반복일 뿐이다. */
function marketOpenNow(): boolean {
  const kst = new Date(Date.now() + KST);
  const dow = kst.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return min >= 9 * 60 && min <= 15 * 60 + 30;
}

/**
 * 인트라데이 버킷 = KST 정시(`YYYY-MM-DDTHH:00+09:00`). cron이 늦게 떠도 "그 시각대 1건"으로
 * 멱등하게 덮어쓴다. 실제 조회 시각은 `as_of_at`에 따로 남기니 정보가 사라지진 않는다.
 */
function kstHourBucket(at: Date): string {
  const kst = new Date(at.getTime() + KST);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  return `${kst.toISOString().slice(0, 10)}T${hh}:00+09:00`;
}

/**
 * `--backfill[=N]` or STOCK_BACKFILL_DAYS=N → collect N calendar days of history.
 * 0 (default) = latest settled day only, which is what the daily cron wants.
 */
function backfillDays(): number {
  const arg = process.argv
    .slice(2)
    .find((a) => a === '--backfill' || a.startsWith('--backfill='));
  const raw = arg ? (arg.split('=')[1] ?? '30') : (process.env.STOCK_BACKFILL_DAYS ?? '0');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid backfill days: ${raw}`);
  // KIS caps how far back these TRs reach anyway; the ceiling just guards typos.
  return Math.min(Math.floor(n), 120);
}

interface SnapshotInput {
  symbol: string;
  source: string;
  metric: string;
  bucket_key: string;
  trading_date_kst?: string | null;
  as_of_at?: string | null;
  collector_run_id: string;
  payload: Record<string, unknown>;
}

/**
 * 실행 자체를 jarvis에 보고한다 (운영 모니터링). 보고가 실패해도 수집은 계속한다 —
 * 모니터링 때문에 데이터 수집을 잃는 건 본말전도.
 */
async function reportRun(
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/stock/collector-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[collect] run report failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
  } catch (e) {
    console.warn(`[collect] run report failed: ${String(e)}`);
  }
}

/**
 * 공시·뉴스 수집. 소스별로 따로 감싸서 **하나가 죽어도 다른 하나는 올라간다**
 * (뉴스 RSS는 외부 서비스라 언제든 형식이 바뀔 수 있다).
 * DART 키가 없으면 공시는 건너뛰고 뉴스만 한다.
 */
async function collectEvents(
  token: string,
  runId: string,
  errors: string[],
): Promise<number> {
  const events: Record<string, unknown>[] = [];

  const dartKey = process.env.DART_API_KEY;
  if (dartKey) {
    try {
      const rows = await fetchDartDisclosures(dartKey, CORP_CODE, 7);
      events.push(...rows.map((e) => ({ ...e, symbol: SYMBOL, collector_run_id: runId })));
      console.log(`[collect] dart ${rows.length}건`);
    } catch (e) {
      errors.push(`dart: ${String(e)}`);
    }
  } else {
    console.log('[collect] dart: DART_API_KEY 없음 — 공시 건너뜀');
  }

  try {
    const rows = await fetchNewsHeadlines(NEWS_QUERY, 48, 40);
    events.push(...rows.map((e) => ({ ...e, symbol: SYMBOL, collector_run_id: runId })));
    console.log(`[collect] news ${rows.length}건 (48시간 이내)`);
  } catch (e) {
    errors.push(`news: ${String(e)}`);
  }

  if (!events.length) return 0;
  try {
    const res = await fetch(`${BASE}/api/stock/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(events),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { upserted?: number };
    console.log(`[collect] events upserted ${body.upserted ?? 0}`);
    return body.upserted ?? 0;
  } catch (e) {
    errors.push(`events post: ${String(e)}`);
    return 0;
  }
}

async function postSnapshot(token: string, snap: SnapshotInput): Promise<void> {
  const res = await fetch(`${BASE}/api/stock/snapshot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${snap.metric} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const creds: KisCreds = {
    appKey: required('KIS_APP_KEY'),
    appSecret: required('KIS_APP_SECRET'),
  };
  const apiToken = required('JARVIS_API_TOKEN');
  const runId = randomUUID();
  const backfill = backfillDays();
  // close/premarket은 워크플로가 알려준다 (어느 cron이 떴는지). 백필은 스스로 안다.
  const kind = process.env.STOCK_RUN_KIND || (backfill ? 'backfill' : 'manual');
  console.log(
    `[collect] run ${runId} symbol=${SYMBOL} kind=${kind} base=${BASE}` +
      (backfill ? ` backfill=${backfill}d` : ''),
  );
  await reportRun(apiToken, {
    id: runId,
    symbol: SYMBOL,
    kind,
    status: 'running',
    finished: false,
  });

  const kisToken = await issueToken(creds);
  const today = kstDay();
  const cutoff = kstDay(backfill).dashed; // only used in backfill mode
  const errors: string[] = [];
  const queue: SnapshotInput[] = [];

  const settled = settledToday();

  // KIS returns newest-first. Drop today's row until the session settles, take the
  // backfill window (or just the latest day), and reverse so we POST oldest-first.
  function pickWindow<T>(rows: T[], dateOf: (r: T) => string, label: string): T[] {
    const usable = settled ? rows : rows.filter((r) => dateOf(r) < today.dashed);
    if (usable.length !== rows.length) {
      console.log(`[collect] ${label}: skipping today's unsettled row (before ${SETTLE_HOUR_KST}:00 KST)`);
    }
    const picked = backfill ? usable.filter((r) => dateOf(r) >= cutoff) : usable.slice(0, 1);
    return picked.reverse();
  }

  // 인트라데이 실행은 현재가 1건만 남긴다. 일봉·수급은 장중에 확정이 아니라서 어차피
  // 위 §확정 전 값 규칙에 걸리고, KIS 호출만 낭비된다.
  if (kind === 'intraday') {
    try {
      if (!marketOpenNow()) {
        console.log('[collect] intraday: 장 시간 밖이라 수집하지 않음');
      } else {
        const at = new Date();
        const q = await currentQuote(kisToken, creds, SYMBOL);
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'intraday_price',
          bucket_key: kstHourBucket(at),
          trading_date_kst: today.dashed,
          as_of_at: at.toISOString(),
          collector_run_id: runId,
          payload: {
            price: q.price,
            change: q.change,
            change_rate: q.changeRate,
            open: q.open,
            high: q.high,
            low: q.low,
            volume: q.volume,
            amount_krw: q.amountKrw,
            amount_unit: 'krw', // 수급(백만원)과 단위가 다르다 — 섞지 말 것
            foreign_ratio: q.foreignRatio,
            foreign_qty: q.foreignQty,
            // 수급의 '질' — 누가 사는지
            foreign_net_qty: q.foreignNetQty,
            program_net_qty: q.programNetQty,
            short_qty: q.shortQty,
            loan_balance_rate: q.loanBalanceRate,
            // 상태 플래그 (빈 값/'N'이면 해당 없음)
            vi_code: q.viCode,
            warn_code: q.warnCode,
            short_over_yn: q.shortOverYn,
            caution_yn: q.cautionYn,
          },
        });
        // 밸류에이션·기준선은 하루 단위로 충분해서 별도 metric(일별 버킷)으로 둔다.
        // 장중 매시 실행이 같은 버킷을 덮어쓰므로 값은 계속 최신이다.
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'valuation',
          bucket_key: today.dashed,
          trading_date_kst: today.dashed,
          as_of_at: at.toISOString(),
          collector_run_id: runId,
          payload: {
            per: q.per,
            pbr: q.pbr,
            eps: q.eps,
            bps: q.bps,
            market_cap: q.marketCap,
            market_cap_unit: 'hundred_million_krw', // 시총은 억원 단위로 온다
            listed_shares: q.listedShares,
            turnover_rate: q.turnoverRate,
            sector: q.sector,
            w52_high: q.w52High,
            w52_low: q.w52Low,
            w52_high_date: q.w52HighDate,
            w52_low_date: q.w52LowDate,
            d250_high: q.d250High,
            d250_low: q.d250Low,
          },
        });
        // 같은 응답에 외국인 보유 지표가 들어 있으니 foreign_holding도 같이 갱신한다
        // (KIS 호출 추가 없음). 이게 없으면 장중 내내 아침 값이 고정돼서, "보유비율이
        // 순매도를 따라 내려오는지" 같은 관찰 항목이 구조적으로 '판단 불가'가 된다
        // — 브리핑 루틴이 스스로 올린 개선노트 819b9c5a.
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'foreign_holding',
          bucket_key: today.dashed,
          trading_date_kst: today.dashed,
          as_of_at: at.toISOString(),
          collector_run_id: runId,
          payload: {
            price: q.price,
            foreign_ratio: q.foreignRatio,
            foreign_qty: q.foreignQty,
          },
        });
        console.log(
          `[collect] intraday_price ${kstHourBucket(at)} (${q.price}원, ${q.changeRate}%) + foreign_holding ${q.foreignRatio}%`,
        );
      }
    } catch (e) {
      errors.push(`intraday_price: ${String(e)}`);
    }
    await collectEvents(apiToken, runId, errors);
    await flush(apiToken, runId, kind, queue, errors);
    return;
  }

  // 1) investor flow
  try {
    const flows = await investorFlows(kisToken, creds, SYMBOL);
    const picked = pickWindow(flows, (f) => ymd(f.date), 'investor_flow');
    if (!picked.length) errors.push('investor_flow: no settled rows');
    for (const f of picked) {
      queue.push({
        symbol: SYMBOL,
        source: 'kis',
        metric: 'investor_flow',
        bucket_key: ymd(f.date),
        trading_date_kst: ymd(f.date),
        collector_run_id: runId,
        payload: {
          close: f.close,
          amount_unit: 'million_krw', // 대금 단위: 백만원
          foreign_net: f.frgnNet,
          institution_net: f.orgnNet,
          individual_net: f.prsnNet,
          foreign_buy: f.frgnBuy,
          foreign_sell: f.frgnSell,
          institution_buy: f.orgnBuy,
          institution_sell: f.orgnSell,
          individual_buy: f.prsnBuy,
          individual_sell: f.prsnSell,
        },
      });
    }
    if (picked.length) {
      console.log(
        `[collect] investor_flow ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`,
      );
    }
  } catch (e) {
    errors.push(`investor_flow: ${String(e)}`);
  }

  // 2) daily OHLCV
  try {
    const start = kstDay(Math.max(backfill, 15)).compact;
    const bars = await dailyCandles(kisToken, creds, SYMBOL, start, today.compact);
    const picked = pickWindow(bars, (b) => ymd(b.date), 'daily_ohlcv');
    if (!picked.length) errors.push('daily_ohlcv: no bars');
    for (const b of picked) {
      queue.push({
        symbol: SYMBOL,
        source: 'kis',
        metric: 'daily_ohlcv',
        bucket_key: ymd(b.date),
        trading_date_kst: ymd(b.date),
        collector_run_id: runId,
        payload: {
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        },
      });
    }
    if (picked.length) {
      console.log(
        `[collect] daily_ohlcv ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`,
      );
    }
  } catch (e) {
    errors.push(`daily_ohlcv: ${String(e)}`);
  }

  // 3) foreign holding — snapshot of *now*; this TR carries no history, so even
  //    a backfill run can only record today's ratio.
  try {
    const fh = await foreignHolding(kisToken, creds, SYMBOL);
    queue.push({
      symbol: SYMBOL,
      source: 'kis',
      metric: 'foreign_holding',
      bucket_key: today.dashed,
      trading_date_kst: today.dashed,
      collector_run_id: runId,
      payload: {
        price: fh.price,
        foreign_ratio: fh.foreignRatio,
        foreign_qty: fh.foreignQty,
      },
    });
    console.log(`[collect] foreign_holding ${today.dashed} (${fh.foreignRatio}%)`);
  } catch (e) {
    errors.push(`foreign_holding: ${String(e)}`);
  }

  // 4) 공시·뉴스. 백필은 과거 데이터 적재라 이벤트를 다시 긁을 이유가 없다.
  if (!backfill) await collectEvents(apiToken, runId, errors);

  await flush(apiToken, runId, kind, queue, errors);
}

/** 모아둔 스냅샷을 오래된 순으로 POST하고, 실행 결과를 보고하고, 실패면 non-zero로 끝낸다. */
async function flush(
  apiToken: string,
  runId: string,
  kind: string,
  queue: SnapshotInput[],
  errors: string[],
): Promise<void> {
  // 한 날짜가 실패해도 나머지 구간은 계속 올린다.
  let posted = 0;
  for (const snap of queue) {
    try {
      await postSnapshot(apiToken, snap);
      posted++;
    } catch (e) {
      errors.push(`${snap.metric} ${snap.bucket_key}: ${String(e)}`);
    }
  }
  console.log(`[collect] posted ${posted}/${queue.length} snapshot(s)`);

  await reportRun(apiToken, {
    id: runId,
    symbol: SYMBOL,
    kind,
    status: errors.length === 0 ? 'ok' : posted > 0 ? 'partial' : 'error',
    finished: true,
    posted,
    failed: errors.length,
    error: errors.length ? errors.join('\n').slice(0, 4000) : null,
  });

  if (errors.length) {
    console.error(`[collect] ${errors.length} error(s):`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('[collect] done');
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
