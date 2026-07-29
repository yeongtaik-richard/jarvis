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
  dailyCandles,
  foreignHolding,
  investorFlows,
  issueToken,
  type KisCreds,
} from '../src/lib/kis-marketdata';

const SYMBOL = process.env.STOCK_SYMBOL ?? '000660'; // SK hynix
const BASE = process.env.JARVIS_BASE_URL ?? 'http://localhost:3000';
const KST = 9 * 3600 * 1000;

function ymd(kisDate: string): string {
  return `${kisDate.slice(0, 4)}-${kisDate.slice(4, 6)}-${kisDate.slice(6, 8)}`;
}
function kstDay(daysAgo = 0): { compact: string; dashed: string } {
  const s = new Date(Date.now() + KST - daysAgo * 86400000).toISOString().slice(0, 10);
  return { compact: s.replace(/-/g, ''), dashed: s };
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
  collector_run_id: string;
  payload: Record<string, unknown>;
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
  console.log(
    `[collect] run ${runId} symbol=${SYMBOL} base=${BASE}` +
      (backfill ? ` backfill=${backfill}d` : ''),
  );

  const kisToken = await issueToken(creds);
  const today = kstDay();
  const cutoff = kstDay(backfill).dashed; // only used in backfill mode
  const errors: string[] = [];
  const queue: SnapshotInput[] = [];

  // KIS returns newest-first. Take the backfill window (or just the latest day)
  // and reverse it so snapshots are POSTed oldest-first.
  function pickWindow<T>(rows: T[], dateOf: (r: T) => string): T[] {
    const picked = backfill ? rows.filter((r) => dateOf(r) >= cutoff) : rows.slice(0, 1);
    return picked.reverse();
  }

  // 1) investor flow
  try {
    const flows = await investorFlows(kisToken, creds, SYMBOL);
    const picked = pickWindow(flows, (f) => ymd(f.date));
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
    const picked = pickWindow(bars, (b) => ymd(b.date));
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

  // POST oldest-first. A single failed day must not drop the rest of the window.
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
