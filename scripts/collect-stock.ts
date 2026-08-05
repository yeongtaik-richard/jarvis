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
 *
 * 긴 백필은 `dailyCandlesRange`가 창을 나눠 받는다 (KIS 일봉은 한 번에 100건 상한).
 * **`investor_flow`는 KIS가 30일치만 주므로** 백필을 길게 잡아도 수급은 그만큼만 늘어난다.
 * 오래 걸리고 POST가 수백 건이라 GitHub Actions에서 돌리는 게 안전하다:
 *   gh workflow run collect-stock.yml -f backfill_days=400
 */
import { randomUUID } from 'node:crypto';
import {
  currentQuote,
  dailyCandles,
  dailyCandlesRange,
  FX_CODES,
  INDEX_CODES,
  indexDaily,
  indexDailyRange,
  overseasIndexDaily,
  overseasIndexDailyRange,
  domesticBusinessDays,
  quarterFinancials,
  minuteBars,
  MINUTE_WINDOWS,
  overseasStockDaily,
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
// 피어 종목(삼성전자)과 ADR. 종목이 안 들어간 벤치마크라 상대강도를 액면대로 읽을 수 있다.
const PEER_CODE = process.env.PEER_CODE ?? '005930';
// 매크로 뉴스 쿼리. 종목 쿼리와 달리 category='macro'로 저장돼 소비 측에서 구분된다.
// 엔캐리·환율 개입 같은 사건은 종목명을 언급하지 않아 기존 쿼리로는 안 잡혔다.
const MACRO_NEWS_QUERY =
  process.env.MACRO_NEWS_QUERY ?? '엔캐리 OR 엔화 개입 OR 원달러 환율';
const ADR = { excd: process.env.ADR_EXCD ?? 'NAS', symb: process.env.ADR_SYMB ?? 'SKHY' };

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

/** KRX 정규장 마감 (15:30 KST). 종가단일가가 이 시각에 확정된다. */
const CLOSE_MIN_KST = 15 * 60 + 30;
/**
 * 마감 후 종가를 잡을 수 있는 시각 상한. `inquire-price`는 장이 끝난 뒤에도 마지막
 * 체결가(=종가)를 그대로 돌려주므로, 이 창 안의 수집은 종가를 확보한다.
 */
const CLOSE_CAPTURE_UNTIL_KST = 16 * 60 + 30;

// now를 받는 이유: 창 경계(15:30 / 16:30)는 테스트 없이 믿을 값이 아니다.
export function kstMinuteOfDay(now = Date.now()): { min: number; weekday: boolean } {
  const kst = new Date(now + KST);
  const dow = kst.getUTCDay();
  return {
    min: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
    weekday: dow !== 0 && dow !== 6,
  };
}

/**
 * 장중 수집을 해도 되는 시각인가 — 정규장 + **마감 후 종가 확보 창**.
 *
 * 예전엔 15:30에서 딱 끊었는데, 그러면 **종가가 한 번도 수집되지 않았다.** 정기 크론은
 * 15:00 KST분이 GitHub 지연으로 15:30 넘어 도착해 이 게이트에 막혔고, 루틴은 close
 * 모드로 넘어가 수집을 부르지 않았다. 그 결과 매일 마지막 관측치가 마감 40~60분 전
 * 값이었다 (2026-08-04: 14:51이 마지막, 그 사이 반등 구간이 통째로 안 보였다).
 */
export function intradayCollectable(now = Date.now()): boolean {
  const { min, weekday } = kstMinuteOfDay(now);
  if (!weekday) return false;
  return min >= 9 * 60 && min <= CLOSE_CAPTURE_UNTIL_KST;
}

/** 정규장이 이미 끝났는가 — 이때 받은 현재가는 종가다. */
export function afterCloseNow(now = Date.now()): boolean {
  const { min, weekday } = kstMinuteOfDay(now);
  return weekday && min > CLOSE_MIN_KST;
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
  // 상한은 오타 방지용이다. 실제 한계는 KIS가 어디까지 주는지로 결정되고,
  // 페이지네이션 루프가 새 데이터가 없으면 스스로 멈춘다.
  return Math.min(Math.floor(n), 1500);
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

  try {
    const rows = await fetchNewsHeadlines(MACRO_NEWS_QUERY, 48, 20, 'macro');
    events.push(...rows.map((e) => ({ ...e, symbol: SYMBOL, collector_run_id: runId })));
    console.log(`[collect] macro news ${rows.length}건`);
  } catch (e) {
    errors.push(`macro news: ${String(e)}`);
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
      if (!intradayCollectable()) {
        console.log('[collect] intraday: 수집 창(09:00~16:30 KST) 밖이라 수집하지 않음');
      } else {
        const at = new Date();
        const q = await currentQuote(kisToken, creds, SYMBOL);
        // 마감 후 수집은 **15:00 버킷에 넣는다.** 현재 시각 버킷(16:00 등)에 넣으면
        // 장이 끝난 뒤에도 거래가 있었던 것처럼 궤적이 늘어난다. 종가는 그날 마지막
        // 시간대의 값이고, 같은 버킷을 덮어쓰므로 여러 번 돌아도 안전하다.
        const bucket = afterCloseNow()
          ? `${today.dashed}T15:00+09:00`
          : kstHourBucket(at);
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'intraday_price',
          bucket_key: bucket,
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
            // 이름 주의: KIS frgn_ntby_qty는 장중 순매수가 아니라 보유수량 일별 변화다
            // (kis-marketdata.ts foreignHoldingDeltaQty 주석 참고). 옛 이름
            // foreign_net_qty로 저장된 행이 08-05 이전에 남아 있다.
            foreign_holding_delta_qty: q.foreignHoldingDeltaQty,
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
          `[collect] intraday_price ${bucket}${afterCloseNow() ? ' (종가)' : ''} (${q.price}원, ${q.changeRate}%) + foreign_holding ${q.foreignRatio}%`,
        );
      }
    } catch (e) {
      errors.push(`intraday_price: ${String(e)}`);
    }
    await collectEvents(apiToken, runId, errors);
    const { posted: intraPosted } = await flush(apiToken, runId, kind, queue, errors);

    // 장중 예측(1시간 뒤·오늘 마감)을 기록한다. 표본이 하루 5~6건씩 쌓여 일별 레인보다
    // 훨씬 빨리 검증된다. flush 뒤라야 방금 받은 분봉·현재가를 근거로 쓴다.
    if (intraPosted > 0) {
      try {
        const res = await fetch(`${BASE}/api/stock/intraday-signal?symbol=${SYMBOL}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}` },
        });
        const body = (await res.json()) as { at?: string; direction?: string; lanes?: Array<{ kind: string; reason: string }> };
        console.log(
          `[collect] intraday-signal ${res.status} ${body.at ?? ''} ${body.direction ?? '방향없음'} ` +
            (body.lanes ?? []).map((l) => `${l.kind}=${l.reason}`).join(' '),
        );
      } catch (e) {
        console.warn(`[collect] intraday-signal failed: ${String(e)}`);
      }
    }
    finishRun(errors);
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
    // 한 번 호출은 100건 상한이라, 백필일 때만 창을 나눠 받는다.
    const bars = backfill
      ? await dailyCandlesRange(kisToken, creds, SYMBOL, start, today.compact, {
          maxCalls: Math.min(20, Math.ceil(backfill / 100) + 2),
        })
      : await dailyCandles(kisToken, creds, SYMBOL, start, today.compact);
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

  // 2b) 벤치마크 지수. 종목과 같은 창을 쓰고, 같은 §확정 전 값 규칙을 적용한다.
  //     "시장이 빠진 건지 이 종목이 빠진 건지"를 가리려면 이게 있어야 한다.
  //     symbol은 추적 종목 그대로 두고 metric으로 구분한다 — 대시보드·국면 계산이
  //     symbol 기준으로 조회하므로, 지수를 별도 symbol로 넣으면 조인이 필요해진다.
  for (const [key, code] of Object.entries(INDEX_CODES)) {
    try {
      const start = kstDay(Math.max(backfill, 15)).compact;
      const rows = backfill
        ? await indexDailyRange(kisToken, creds, code, start, today.compact, {
            // 지수는 페이지가 50건이라 종목(100건)보다 호출이 두 배 필요하다.
            maxCalls: Math.min(30, Math.ceil(backfill / 50) + 2),
          })
        : await indexDaily(kisToken, creds, code, start, today.compact);
      const picked = pickWindow(rows, (r) => ymd(r.date), `benchmark_${key}`);
      for (const r of picked) {
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: `benchmark_${key}`,
          bucket_key: ymd(r.date),
          trading_date_kst: ymd(r.date),
          collector_run_id: runId,
          payload: {
            index_code: code,
            close: r.close,
            open: r.open,
            high: r.high,
            low: r.low,
            volume: r.volume,
          },
        });
      }
      if (picked.length) {
        console.log(
          `[collect] benchmark_${key} ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`,
        );
      }
    } catch (e) {
      errors.push(`benchmark_${key}: ${String(e)}`);
    }
  }

  // 2c) 종목이 포함되지 않은 벤치마크 — 이쪽이 상대강도의 본론이다.
  //     SOX는 미국 세션이 KRX보다 한 박자 늦게 끝나므로 최신 행이 곧 오버나이트 정보다.
  for (const [key, code] of [
    ['sox', 'SOX'],
    ['nasdaq', 'COMP'],
  ] as const) {
    try {
      const start = kstDay(Math.max(backfill, 15)).compact;
      const rows = backfill
        ? await overseasIndexDailyRange(kisToken, creds, code, start, today.compact, {
            maxCalls: Math.min(20, Math.ceil(backfill / 100) + 2),
          })
        : await overseasIndexDaily(kisToken, creds, code, start, today.compact);
      // 해외 세션은 KRX 기준 '오늘'이 아직 끝나지 않았을 수 있어 오늘 날짜 행은 버린다.
      const usable = rows.filter((r) => ymd(r.date) < today.dashed);
      const picked = backfill ? usable.slice().reverse() : usable.slice(0, 1).reverse();
      for (const r of picked) {
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: `benchmark_${key}`,
          bucket_key: ymd(r.date),
          trading_date_kst: ymd(r.date),
          collector_run_id: runId,
          payload: { index_code: code, close: r.close, open: r.open, high: r.high, low: r.low, volume: r.volume },
        });
      }
      if (picked.length) {
        console.log(`[collect] benchmark_${key} ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`);
      }
    } catch (e) {
      errors.push(`benchmark_${key}: ${String(e)}`);
    }
  }

  // 2d) 피어(삼성전자). 종목 일봉 TR을 그대로 쓴다.
  try {
    const start = kstDay(Math.max(backfill, 15)).compact;
    const bars = backfill
      ? await dailyCandlesRange(kisToken, creds, PEER_CODE, start, today.compact, {
          maxCalls: Math.min(20, Math.ceil(backfill / 100) + 2),
        })
      : await dailyCandles(kisToken, creds, PEER_CODE, start, today.compact);
    const picked = pickWindow(bars, (b) => ymd(b.date), 'benchmark_samsung');
    for (const b of picked) {
      queue.push({
        symbol: SYMBOL,
        source: 'kis',
        metric: 'benchmark_samsung',
        bucket_key: ymd(b.date),
        trading_date_kst: ymd(b.date),
        collector_run_id: runId,
        payload: { peer_code: PEER_CODE, close: b.close, open: b.open, high: b.high, low: b.low, volume: b.volume },
      });
    }
    if (picked.length) {
      console.log(`[collect] benchmark_samsung ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`);
    }
  } catch (e) {
    errors.push(`benchmark_samsung: ${String(e)}`);
  }

  // 2d-2) 환율. 벤치마크(초과수익 비교 대상)가 아니라 **매크로 지표**다 — 엔캐리 청산
  //       리스크는 USD/JPY가, 외국인 수급 환경은 USD/KRW가 선행한다. metric 접두사도
  //       benchmark_가 아닌 fx_로 구분한다.
  for (const [key, code] of Object.entries(FX_CODES)) {
    try {
      const start = kstDay(Math.max(backfill, 25)).compact;
      const rows = backfill
        ? await overseasIndexDailyRange(kisToken, creds, code, start, today.compact, {
            maxCalls: Math.min(20, Math.ceil(backfill / 100) + 2),
            marketDiv: 'X',
          })
        : await overseasIndexDaily(kisToken, creds, code, start, today.compact, 'X');
      // FX는 KRW 쌍이 오늘 날짜를 장중 값으로 주기도 한다 — 확정 전 값 규칙 동일 적용.
      const usable = rows.filter((r) => ymd(r.date) < today.dashed);
      const picked = (backfill ? usable.slice() : usable.slice(0, 1)).reverse();
      for (const r of picked) {
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: `fx_${key}`,
          bucket_key: ymd(r.date),
          trading_date_kst: ymd(r.date),
          collector_run_id: runId,
          payload: { fx_code: code, close: r.close, open: r.open, high: r.high, low: r.low },
        });
      }
      if (picked.length) {
        console.log(`[collect] fx_${key} ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`);
      }
    } catch (e) {
      errors.push(`fx_${key}: ${String(e)}`);
    }
  }

  // 2e) ADR. 벤치마크가 아니라 **같은 회사의 다른 세션**이다 — 초과수익 비교 대상이 아니고,
  //     오버나이트 괴리를 보는 용도다. 이력이 15거래일뿐이고 BYMD 페이징이 안 된다.
  try {
    const rows = await overseasStockDaily(kisToken, creds, ADR.excd, ADR.symb);
    const usable = rows.filter((r) => ymd(r.date) < today.dashed);
    const picked = (backfill ? usable.slice() : usable.slice(0, 1)).reverse();
    for (const r of picked) {
      queue.push({
        symbol: SYMBOL,
        source: 'kis',
        metric: 'adr_price',
        bucket_key: ymd(r.date),
        trading_date_kst: ymd(r.date),
        collector_run_id: runId,
        payload: {
          ticker: ADR.symb,
          exchange: ADR.excd,
          currency: 'USD',
          close: r.close, open: r.open, high: r.high, low: r.low, volume: r.volume,
        },
      });
    }
    if (picked.length) {
      console.log(`[collect] adr_price ${picked.length} day(s): ${ymd(picked[0]!.date)}..${ymd(picked.at(-1)!.date)}`);
    }
  } catch (e) {
    errors.push(`adr_price: ${String(e)}`);
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

  // 3b) 거래일 달력. 미래 휴장일은 역산할 수 없어서 KIS에서 받아 저장한다 —
  //     "5거래일 뒤"를 정확히 세려면 이게 있어야 한다 (market-calendar.ts 참고).
  //     하루 한 번이면 충분하고 장중엔 바뀌지 않으므로 마감·프리마켓에서만.
  if (!backfill && (kind === 'close' || kind === 'premarket')) {
    try {
      const days = await domesticBusinessDays(kisToken, creds, today.compact);
      const closed = days.filter((d) => !d.openMarket).map((d) => d.date);
      const covered = days.map((d) => d.date).sort();
      if (covered.length > 0) {
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'market_calendar',
          bucket_key: today.dashed,
          trading_date_kst: today.dashed,
          as_of_at: new Date().toISOString(),
          collector_run_id: runId,
          payload: { from: covered[0], to: covered[covered.length - 1], closed },
        });
        console.log(
          `[collect] market_calendar ${covered[0]}~${covered[covered.length - 1]} (휴장 ${closed.length}일)`,
        );
      }
    } catch (e) {
      errors.push(`market_calendar: ${String(e)}`);
    }
  }

  // 3b-2) 분봉. 10분·1시간 지평의 재료다 — 시간당 스냅샷 1건으로는 채점이 안 된다.
  //       장중엔 방금 지난 구간만 받고(호출 2회), 마감엔 하루 전체를 다시 받아 빈 구간을
  //       메운다(13회). 같은 시간 버킷을 덮어쓰므로 여러 번 돌아도 안전하다.
  if (!backfill && (kind === 'intraday' || kind === 'close')) {
    try {
      const windows =
        kind === 'close'
          ? [...MINUTE_WINDOWS]
          : MINUTE_WINDOWS.filter((w) => {
              const wm = Number(w.slice(0, 2)) * 60 + Number(w.slice(2, 4));
              const nowMin = kstMinuteOfDay().min;
              return wm <= nowMin && wm > nowMin - 90; // 방금 지난 90분
            });
      const byHour = new Map<string, Array<Record<string, unknown>>>();
      for (const w of windows) {
        const bars = await minuteBars(kisToken, creds, SYMBOL, w);
        for (const b of bars) {
          const hh = b.time.slice(0, 2);
          const arr = byHour.get(hh) ?? [];
          arr.push({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
          byHour.set(hh, arr);
        }
      }
      for (const [hh, bars] of byHour) {
        // 같은 분이 페이지 경계에서 겹칠 수 있다
        const seen = new Set<string>();
        const uniq = bars
          .filter((b) => (seen.has(String(b.t)) ? false : (seen.add(String(b.t)), true)))
          .sort((a, b) => String(a.t).localeCompare(String(b.t)));
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'minute_bars',
          bucket_key: `${today.dashed}T${hh}:00+09:00`,
          trading_date_kst: today.dashed,
          as_of_at: new Date().toISOString(),
          collector_run_id: runId,
          payload: { bars: uniq },
        });
      }
      const total = [...byHour.values()].reduce((a, b) => a + b.length, 0);
      console.log(`[collect] minute_bars ${windows.length}창 → ${byHour.size}시간 버킷, ${total}분`);
    } catch (e) {
      errors.push(`minute_bars: ${String(e)}`);
    }
  }

  // 3c) 분기 재무. 긴 지평(6달·1년)은 방향 대신 "위치"로 답하는데 그 재료다
  //     (stock-position.ts 참고). 분기마다 바뀌니 하루 한 번이면 충분하다.
  if (!backfill && (kind === 'close' || kind === 'premarket')) {
    try {
      const fins = await quarterFinancials(kisToken, creds, SYMBOL);
      if (fins.length > 0) {
        queue.push({
          symbol: SYMBOL,
          source: 'kis',
          metric: 'quarter_financials',
          bucket_key: fins[0]!.period,
          trading_date_kst: today.dashed,
          as_of_at: new Date().toISOString(),
          collector_run_id: runId,
          payload: { quarters: fins },
        });
        console.log(`[collect] quarter_financials ${fins.length}분기 (최신 ${fins[0]!.period})`);
      }
    } catch (e) {
      errors.push(`quarter_financials: ${String(e)}`);
    }
  }

  // 4) 공시·뉴스. 백필은 과거 데이터 적재라 이벤트를 다시 긁을 이유가 없다.
  if (!backfill) await collectEvents(apiToken, runId, errors);

  const { posted } = await flush(apiToken, runId, kind, queue, errors);

  // 5) 스냅샷이 올라간 뒤 오늘 신호를 기록한다. **flush의 exit보다 먼저** 와야 한다 —
  //    부수적인 실패 하나(adr_price 초당 호출 제한, DART 일시 장애) 때문에 그날 예측
  //    표본이 통째로 사라지면 안 된다. 2026-07-31 close(partial)에서 실제로 그랬다.
  //    핵심 스냅샷이 하나도 안 올라갔을 때만 건너뛴다 — 그땐 신호가 어제 봉으로 계산돼
  //    기준일이 어긋난다.
  if (kind === 'close' && !backfill) {
    const coreQueued = queue.some(
      (q) => q.metric === 'daily_ohlcv' || q.metric === 'investor_flow',
    );
    if (!coreQueued || posted === 0) {
      console.warn('[collect] signal skipped: 핵심 스냅샷이 올라가지 않았다');
    } else {
      try {
        const res = await fetch(`${BASE}/api/stock/signal?symbol=${SYMBOL}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}` },
        });
        const body = (await res.json()) as { recorded?: boolean; reason?: string };
        console.log(`[collect] signal ${res.status} recorded=${body.recorded} (${body.reason})`);
      } catch (e) {
        console.warn(`[collect] signal record failed: ${String(e)}`); // 신호 실패가 수집을 망치지 않게
      }
    }
  }

  // 5b) 프리마켓 예측 — 간밤 해외장으로 당일 시가·종가를 예측한다. 개장 전에만
  //      기록되고, 서버가 09:00 이후 호출을 거절한다.
  if (kind === 'premarket' && !backfill && posted > 0) {
    try {
      const res = await fetch(`${BASE}/api/stock/premarket-signal?symbol=${SYMBOL}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}` },
      });
      const body = (await res.json()) as { direction?: string; lanes?: Array<{ kind: string; reason: string }> };
      console.log(
        `[collect] premarket-signal ${res.status} ${body.direction ?? '방향없음'} ` +
          (body.lanes ?? []).map((l) => `${l.kind}=${l.reason}`).join(' '),
      );
    } catch (e) {
      console.warn(`[collect] premarket-signal failed: ${String(e)}`);
    }
  }

  // 실패 종료는 맨 마지막. 여기까지 와야 부분 실패에도 신호가 기록된다.
  finishRun(errors);
}

/**
 * 종료 코드를 정한다. **flush에서 분리한 이유**: flush 직후에 끝내면 부분 실패
 * 하나로 그날 신호 기록까지 잃는다. 호출부가 남은 일을 다 마친 뒤 부른다.
 */
function finishRun(errors: string[]): void {
  if (errors.length) {
    console.error(`[collect] ${errors.length} error(s):`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('[collect] done');
}

/** 모아둔 스냅샷을 오래된 순으로 POST하고 실행 결과를 보고한다. 종료 코드는 호출부가 정한다. */
async function flush(
  apiToken: string,
  runId: string,
  kind: string,
  queue: SnapshotInput[],
  errors: string[],
): Promise<{ posted: number }> {
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

  // **여기서 exit하지 않는다.** 호출부가 신호 기록까지 마친 뒤 종료 코드를 정한다.
  return { posted };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

// 직접 실행일 때만 돈다. 이 파일에서 게이트 함수를 import해 테스트할 수 있어야 하고,
// import만으로 수집이 시작되면 실수로 실데이터를 건드리게 된다.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
