/**
 * 테마 ETF 일봉 수집기.
 *
 * `collect-stock.ts`와 **일부러 분리했다.** 저쪽은 한 종목에 대해 수급·밸류에이션·
 * 벤치마크·공시까지 받는 복잡한 파이프라인이고, 벤치마크를 `symbol='000660'` 아래
 * metric으로 저장하는 등 단일 종목을 전제한 구조가 섞여 있다. 거기에 다종목 루프를
 * 끼워 넣으면 돌아가는 파이프라인을 건드리게 된다. 이쪽은 **일봉만** 받는다.
 *
 * 저장은 기존 스냅샷 API를 그대로 쓴다 — 자연키가 `(symbol, source, metric,
 * bucket_key)`라 ETF는 그냥 다른 symbol이다. 스키마 변경이 필요 없다.
 *
 * Usage:
 *   pnpm collect:etf                  # 최근 확정일만
 *   pnpm collect:etf --backfill=900   # 900일치 백필 (2년 3개월)
 *   gh workflow run collect-etf.yml -f backfill_days=900
 *
 * Env: KIS_APP_KEY, KIS_APP_SECRET, JARVIS_API_TOKEN, JARVIS_BASE_URL
 */

import { randomUUID } from 'node:crypto';
import { dailyCandles, dailyCandlesRange, type KisCreds } from '../src/lib/kis-marketdata';
import { getKisToken } from '../src/lib/kis-token-cache';
import { THEME_UNIVERSE, type ThemeEtf } from '../src/lib/theme-universe';

const BASE = process.env.JARVIS_BASE_URL ?? 'http://localhost:3000';
const KST = 9 * 3600 * 1000;

function ymd(kisDate: string): string {
  return `${kisDate.slice(0, 4)}-${kisDate.slice(4, 6)}-${kisDate.slice(6, 8)}`;
}
function kstDay(daysAgo = 0): { compact: string; dashed: string } {
  const s = new Date(Date.now() + KST - daysAgo * 86400000).toISOString().slice(0, 10);
  return { compact: s.replace(/-/g, ''), dashed: s };
}
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function backfillDays(): number {
  const arg = process.argv
    .slice(2)
    .find((a) => a === '--backfill' || a.startsWith('--backfill='));
  const raw = arg ? (arg.split('=')[1] ?? '30') : (process.env.ETF_BACKFILL_DAYS ?? '0');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid backfill days: ${raw}`);
  return Math.min(Math.floor(n), 1500);
}

/**
 * 유니버스 전체를 받는다 — 테마도 기준선(나스닥100·S&P500)도.
 *
 * 한때 `--pending`으로 일부를 빼는 분기가 있었다. 로테이션 백테스트가 공통 구간을
 * 필요로 해서 어린 ETF를 제외해야 했기 때문인데, 추이 보드로 방향을 틀면서 그 제약이
 * 사라졌다. 각자 가진 만큼만 그리면 된다.
 */
function universe(): ThemeEtf[] {
  return THEME_UNIVERSE;
}

// KRX 정규장 마감 + 종가단일가 정리. 이 시각 전의 "오늘"은 확정 일봉이 아니다.
const SETTLE_HOUR_KST = 16;
function todaySettled(): boolean {
  return new Date(Date.now() + KST).getUTCHours() >= SETTLE_HOUR_KST;
}

interface SnapshotInput {
  symbol: string;
  source: string;
  metric: string;
  bucket_key: string;
  trading_date_kst: string;
  collector_run_id: string;
  payload: Record<string, unknown>;
}

async function postSnapshot(token: string, snap: SnapshotInput): Promise<void> {
  const res = await fetch(`${BASE}/api/stock/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${snap.symbol} ${snap.bucket_key} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const creds: KisCreds = {
    appKey: required('KIS_APP_KEY'),
    appSecret: required('KIS_APP_SECRET'),
  };
  const apiToken = required('JARVIS_API_TOKEN');
  const backfill = backfillDays();
  const etfs = universe();
  // 배치 묶음 키다. `collector_runs`에 짝이 되는 행은 **만들지 않는다** — 저 테이블은
  // `symbol` 단위 실행 기록인데 이 수집기는 한 번에 여러 종목을 돈다. 억지로 한 행에
  // 욱여넣으면 `/api/stock/health`의 종목별 생존 판정이 망가진다. 컬럼에 FK가 없어
  // (`drizzle/0004_stock_snapshots.sql`) 값만 남겨도 안전하고, "이 백필이 쓴 것"을
  // 조인 없이 추적하는 용도로는 그대로 쓸모가 있다.
  const runId = randomUUID();
  const today = kstDay();
  const settled = todaySettled();

  console.log(
    `[etf] run ${runId} · ${etfs.length} ETF · ${backfill ? `backfill=${backfill}d` : 'latest only'}` +
      `${settled ? '' : ' · 오늘은 미확정이라 제외'}`,
  );

  const { token: kisToken, reused } = await getKisToken(creds, BASE, apiToken);
  console.log(`[etf] KIS token ${reused ? 'reused' : 'issued'}`);

  const errors: string[] = [];
  let posted = 0;

  for (const etf of etfs) {
    try {
      // 상장 전 구간을 달라고 하면 KIS가 빈 응답이나 엉뚱한 값을 줄 수 있어, 창을
      // 상장일로 잘라서 요청한다.
      const wantFrom = kstDay(Math.max(backfill, 15)).dashed;
      const from = wantFrom < etf.listedOn ? etf.listedOn : wantFrom;
      const start = from.replace(/-/g, '');

      const bars = backfill
        ? await dailyCandlesRange(kisToken, creds, etf.code, start, today.compact, {
            maxCalls: Math.min(20, Math.ceil(backfill / 100) + 2),
          })
        : await dailyCandles(kisToken, creds, etf.code, start, today.compact);

      // 오늘이 미확정이면 진행 중인 부분 봉이 섞여 들어온다 — 그대로 저장하면
      // 종가가 아닌 값이 종가 자리에 박힌다.
      const usable = bars.filter((b) => settled || ymd(b.date) !== today.dashed);
      if (!usable.length) {
        errors.push(`${etf.code} ${etf.name}: no bars`);
        continue;
      }

      // 오래된 것부터 올린다 — 중간에 실패해도 앞쪽 구간은 연속으로 남는다.
      const ordered = [...usable].sort((a, b) => a.date.localeCompare(b.date));
      for (const b of ordered) {
        const day = ymd(b.date);
        try {
          await postSnapshot(apiToken, {
            symbol: etf.code,
            source: 'kis',
            metric: 'daily_ohlcv',
            bucket_key: day,
            trading_date_kst: day,
            collector_run_id: runId,
            payload: {
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              // 테마 식별자를 payload에 같이 둔다 — 백테스트가 코드를 외우지 않아도
              // 되고, 나중에 ETF를 교체해도 테마 시계열이 이어진다.
              theme_key: etf.key,
              theme_label: etf.label,
              etf_name: etf.name,
              market: etf.market,
              kind: etf.kind,
            },
          });
          posted++;
        } catch (e) {
          errors.push(`${etf.code} ${day}: ${String(e)}`);
        }
      }
      console.log(
        `[etf] ${etf.code} ${etf.name}: ${ordered.length}일 ` +
          `(${ymd(ordered[0]!.date)}..${ymd(ordered.at(-1)!.date)})`,
      );
    } catch (e) {
      errors.push(`${etf.code} ${etf.name}: ${String(e)}`);
    }
  }

  console.log(`[etf] posted ${posted} snapshot(s), ${errors.length} error(s)`);
  for (const e of errors.slice(0, 20)) console.error(`  ! ${e}`);
  // 일부 실패는 재실행하면 멱등하게 메워진다. 전부 실패했을 때만 실패로 끝낸다.
  if (posted === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
