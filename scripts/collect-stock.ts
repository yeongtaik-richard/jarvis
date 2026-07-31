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
  INDEX_CODES,
  indexDaily,
  indexDailyRange,
  overseasIndexDaily,
  overseasIndexDailyRange,
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

  // 4) 공시·뉴스. 백필은 과거 데이터 적재라 이벤트를 다시 긁을 이유가 없다.
  if (!backfill) await collectEvents(apiToken, runId, errors);

  await flush(apiToken, runId, kind, queue, errors);

  // 5) 마감 수집이 성공했으면(위 flush는 실패 시 exit) 오늘 신호를 기록한다.
  //    LLM 세션에 맡기지 않는 이유: 신호 기록은 결정론적이어야 하고, 루틴이 안 떠도
  //    표본이 쌓여야 한다. 서버가 watch/중복이면 알아서 기록하지 않는다.
  if (kind === 'close' && !backfill) {
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
