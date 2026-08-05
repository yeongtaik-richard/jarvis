/**
 * 프리마켓 예측 기록 — 개장 전에만 쓴다.
 *
 * 두 대상을 각각 남긴다:
 * - **당일 시가** — 갭. 개장 뒤엔 의미가 없다.
 * - **당일 종가** — 전날 18:43 레인(`directional_1d`)과 **같은 대상**이다.
 *   둘을 나란히 채점하면 간밤 해외장이 얼마나 값어치 있는지가 실전으로 측정된다.
 *   그게 이 레인을 따로 만든 이유다.
 *
 * 기준은 둘 다 **전일 확정 종가**다 — 측정을 그 기준으로 했으니 기록도 같아야 한다.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions } from '@/db/schema';
import { createPrediction, toApiPrediction, type ApiPrediction } from './prediction-service';
import { computePremarketSignal, type OvernightInput } from './stock-premarket-signal';
import { getStockHistory } from './stock-service';
import { HttpError } from './errors';

/** 개장. 이 시각을 넘으면 시가를 보고 시가를 예측하는 꼴이라 기록하지 않는다. */
const OPEN_MIN = 9 * 60;

export type PremarketLane = {
  kind: 'directional_pm_open' | 'directional_pm_close';
  label: string;
  recorded: boolean;
  reason: 'recorded' | 'already_pending' | 'no_direction' | 'after_open' | 'post_hoc' | 'no_data';
  prediction: ApiPrediction | null;
};

export type PremarketResult = {
  tradingDate: string | null;
  direction: 'up' | 'down' | null;
  headline: string | null;
  lanes: PremarketLane[];
};

const n = (p: unknown, k: string): number | null => {
  const v = Number((p as Record<string, unknown> | null)?.[k]);
  return Number.isFinite(v) ? v : null;
};

/** 시리즈의 마지막 1일 변화율. `before` 이전 날짜만 쓴다(프리마켓 시점 정보 제한). */
async function overnightPct(
  symbol: string,
  metric: string,
  before: string,
): Promise<number | null> {
  const rows = await getStockHistory(symbol, metric, 40);
  const s = rows
    .map((r) => ({ d: r.bucketKey, c: n(r.payload, 'close') }))
    .filter((x): x is { d: string; c: number } => x.c !== null && x.c > 0 && x.d < before)
    .sort((a, b) => a.d.localeCompare(b.d));
  if (s.length < 2) return null;
  return (s[s.length - 1]!.c / s[s.length - 2]!.c - 1) * 100;
}

export async function recordPremarketSignal(symbol: string): Promise<PremarketResult> {
  const kst = new Date(Date.now() + 9 * 3_600_000);
  const today = kst.toISOString().slice(0, 10);
  const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const empty: PremarketResult = { tradingDate: today, direction: null, headline: null, lanes: [] };

  const [sox, nasdaq, usdkrw, adr, ohlcv] = await Promise.all([
    overnightPct(symbol, 'benchmark_sox', today),
    overnightPct(symbol, 'benchmark_nasdaq', today),
    overnightPct(symbol, 'fx_usdkrw', today),
    overnightPct(symbol, 'adr_price', today),
    getStockHistory(symbol, 'daily_ohlcv', 3),
  ]);
  const prev = ohlcv[ohlcv.length - 1];
  const prevClose = prev ? n(prev.payload, 'close') : null;
  // 전일 확정 종가가 없으면 기준을 못 잡는다. 오늘 봉이 이미 있으면 프리마켓이 아니다.
  if (!prevClose || prev!.bucketKey >= today) {
    return { ...empty, lanes: [{ kind: 'directional_pm_close', label: '당일 종가', recorded: false, reason: 'no_data', prediction: null }] };
  }

  const input: OvernightInput = {
    soxPct: sox,
    nasdaqPct: nasdaq,
    usdkrwPct: usdkrw,
    adrPct: adr,
  };
  const sig = computePremarketSignal(input);
  if (!sig) return { ...empty, lanes: [{ kind: 'directional_pm_close', label: '당일 종가', recorded: false, reason: 'no_data', prediction: null }] };

  const result: PremarketResult = {
    tradingDate: today,
    direction: sig.direction,
    headline: sig.headline,
    lanes: [],
  };

  const plan = [
    { kind: 'directional_pm_open' as const, label: '당일 시가', field: 'open' },
    { kind: 'directional_pm_close' as const, label: '당일 종가', field: 'close' },
  ];

  for (const p of plan) {
    if (nowMin >= OPEN_MIN) {
      result.lanes.push({ kind: p.kind, label: p.label, recorded: false, reason: 'after_open', prediction: null });
      continue;
    }
    if (!sig.direction) {
      result.lanes.push({ kind: p.kind, label: p.label, recorded: false, reason: 'no_direction', prediction: null });
      continue;
    }
    const [dup] = await db
      .select({ id: stockPredictions.id })
      .from(stockPredictions)
      .where(
        and(
          eq(stockPredictions.symbol, symbol),
          eq(stockPredictions.kind, p.kind),
          eq(stockPredictions.targetBucket, today),
        ),
      )
      .limit(1);
    if (dup) {
      result.lanes.push({ kind: p.kind, label: p.label, recorded: false, reason: 'already_pending', prediction: null });
      continue;
    }
    try {
      const row = await createPrediction({
        symbol,
        analysis_id: null,
        authored_by: 'premarket-signal',
        kind: p.kind,
        claim: `프리마켓 ${sig.direction === 'up' ? '상방' : '하방'} (${p.label}): 전일 종가 ${prevClose.toLocaleString('ko-KR')}원보다 ${sig.direction === 'up' ? '높은지' : '낮은지'} — ${sig.headline}`,
        metric: 'daily_ohlcv',
        field: p.field,
        comparator: sig.direction === 'up' ? 'gt' : 'lt',
        threshold: prevClose,
        target_bucket: today,
        context: {
          as_of: prev!.bucketKey,
          variant: 'premarket',
          score: sig.score,
          passed: true,
          horizon: p.kind,
          components: Object.fromEntries(sig.components.map((c) => [c.key, c.value])),
          overnight: { sox, nasdaq, usdkrw, adr },
        },
      });
      result.lanes.push({ kind: p.kind, label: p.label, recorded: true, reason: 'recorded', prediction: toApiPrediction(row) });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        result.lanes.push({ kind: p.kind, label: p.label, recorded: false, reason: 'post_hoc', prediction: null });
        continue;
      }
      throw e;
    }
  }
  return result;
}
