/**
 * Stock reference-info collector (PLAN-DASHBOARD P0b). Fetches read-only market
 * data from KIS and POSTs normalized snapshots to the jarvis API. Designed to
 * run from GitHub Actions cron (post-close) — NOT inside Vercel.
 *
 * Env: KIS_APP_KEY, KIS_APP_SECRET, JARVIS_API_TOKEN, JARVIS_BASE_URL
 *   local:  pnpm collect:stock            (uses .env.local)
 *   CI:     tsx scripts/collect-stock.ts  (env from GitHub Secrets)
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
function kstToday(): { compact: string; dashed: string } {
  const s = new Date(Date.now() + KST).toISOString().slice(0, 10);
  return { compact: s.replace(/-/g, ''), dashed: s };
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
  console.log(`[collect] run ${runId} symbol=${SYMBOL} base=${BASE}`);

  const kisToken = await issueToken(creds);
  const today = kstToday();
  const errors: string[] = [];

  // 1) investor flow (latest settled day)
  try {
    const flows = await investorFlows(kisToken, creds, SYMBOL);
    const latest = flows[0];
    if (latest) {
      await postSnapshot(apiToken, {
        symbol: SYMBOL,
        source: 'kis',
        metric: 'investor_flow',
        bucket_key: ymd(latest.date),
        trading_date_kst: ymd(latest.date),
        collector_run_id: runId,
        payload: {
          close: latest.close,
          foreign_net: latest.frgnNet,
          institution_net: latest.orgnNet,
          individual_net: latest.prsnNet,
        },
      });
      console.log(`[collect] investor_flow ${ymd(latest.date)} ok`);
    } else {
      errors.push('investor_flow: no settled rows');
    }
  } catch (e) {
    errors.push(`investor_flow: ${String(e)}`);
  }

  // 2) daily OHLCV (latest bar)
  try {
    const start = new Date(Date.now() + KST - 15 * 86400000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
    const bars = await dailyCandles(kisToken, creds, SYMBOL, start, today.compact);
    const latest = bars[0];
    if (latest) {
      await postSnapshot(apiToken, {
        symbol: SYMBOL,
        source: 'kis',
        metric: 'daily_ohlcv',
        bucket_key: ymd(latest.date),
        trading_date_kst: ymd(latest.date),
        collector_run_id: runId,
        payload: {
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume,
        },
      });
      console.log(`[collect] daily_ohlcv ${ymd(latest.date)} ok`);
    } else {
      errors.push('daily_ohlcv: no bars');
    }
  } catch (e) {
    errors.push(`daily_ohlcv: ${String(e)}`);
  }

  // 3) foreign holding (current)
  try {
    const fh = await foreignHolding(kisToken, creds, SYMBOL);
    await postSnapshot(apiToken, {
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
    console.log(`[collect] foreign_holding ${today.dashed} ok (${fh.foreignRatio}%)`);
  } catch (e) {
    errors.push(`foreign_holding: ${String(e)}`);
  }

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
