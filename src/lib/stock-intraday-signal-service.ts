/**
 * 장중 예측 레인 — 1시간 뒤, 그리고 오늘 마감.
 *
 * 일별 레인(`stock-signal-service.ts`)과 나란한 물건이고, 다른 점은 셋이다:
 * - **재료가 다르다.** 확정 봉의 MA·20일 수급이 아니라 오늘의 궤적·프로그램·전일 수급.
 *   판정은 `computeIntradayRead`가 이미 하고 있어서 그대로 쓴다.
 * - **표본이 훨씬 빨리 쌓인다.** 하루 5~6건씩이라 30표본까지 일주일이다. 익일 지평 6주,
 *   다음주 지평 7개월과 비교하면 여기가 제일 먼저 답을 낸다.
 * - **채점 기준이 "지금 가격"이다.** 전일 종가가 아니라 예측 시점 가격 대비로 본다 —
 *   "남은 시간 어느 쪽"이 알고 싶은 것이지 오늘 하루 방향이 아니다.
 *
 * ## 예측 시점을 우리가 고르지 않는다
 * 격자는 **수집이 일어난 시각**이다. GitHub cron이 :33~:51로 흔들리지만 그건 우리가
 * 못 정하는 값이라 체리피킹이 안 된다. 시간 버킷당 1건으로 막아서, 루틴이 온디맨드로
 * 추가 수집을 불러도 표본이 부풀지 않게 한다.
 *
 * ## 채점
 * - h1: 예측 시각 + 60분의 **분봉**으로 정확히 잰다. 시간 버킷으로 뭉뚱그리면 수집
 *   지연만큼 지평이 흔들린다.
 * - d0: 오늘 확정 일봉 종가. 마감 수집(18:43) 때 채점된다.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions } from '@/db/schema';
import { createPrediction, toApiPrediction, type ApiPrediction } from './prediction-service';
import { computeIntradayRead, type IntradayBucket } from './stock-intraday-read';
import { getStockHistory } from './stock-service';
import { HttpError } from './errors';

/** 마감 60분 전부터는 1시간 예측을 내지 않는다 — 대상 시각이 장 밖이 된다. */
const H1_CUTOFF_MIN = 14 * 60 + 30;
/** 개장 직후는 궤적이 없어 읽기가 성립하지 않는다. */
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 15 * 60 + 30;

export type IntradayLane = {
  kind: 'directional_h1' | 'directional_d0';
  label: string;
  recorded: boolean;
  reason: 'recorded' | 'already_pending' | 'no_direction' | 'out_of_window' | 'post_hoc';
  prediction: ApiPrediction | null;
};

export type IntradayRecordResult = {
  at: string | null;
  direction: 'up' | 'down' | null;
  headline: string | null;
  lanes: IntradayLane[];
};

const num = (p: unknown, k: string): number | null => {
  const v = Number((p as Record<string, unknown> | null)?.[k]);
  return Number.isFinite(v) ? v : null;
};

const kstNow = () => new Date(Date.now() + 9 * 3_600_000);
const hhmm = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

/**
 * 장중 예측을 기록한다. 수집기가 장중 실행 끝에 부른다.
 * 부작용이 있으므로 조회용으로 쓰지 말 것.
 */
export async function recordIntradaySignal(symbol: string): Promise<IntradayRecordResult> {
  const now = kstNow();
  const today = now.toISOString().slice(0, 10);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const empty: IntradayRecordResult = { at: null, direction: null, headline: null, lanes: [] };

  const [intraRows, flowRows] = await Promise.all([
    getStockHistory(symbol, 'intraday_price', 14),
    getStockHistory(symbol, 'investor_flow', 2),
  ]);
  const buckets: IntradayBucket[] = intraRows
    .filter((r) => r.bucketKey.startsWith(today))
    .map((r) => ({
      bucketKey: r.bucketKey,
      price: num(r.payload, 'price') ?? NaN,
      changeRate: num(r.payload, 'change_rate'),
      open: num(r.payload, 'open'),
      high: num(r.payload, 'high'),
      low: num(r.payload, 'low'),
      programNetQty: num(r.payload, 'program_net_qty'),
      foreignHoldingDeltaQty:
        num(r.payload, 'foreign_holding_delta_qty') ?? num(r.payload, 'foreign_net_qty'),
    }))
    .filter((b) => Number.isFinite(b.price));
  if (buckets.length === 0) return empty;

  const prev = flowRows[flowRows.length - 1];
  const prevFlowSum = prev
    ? (num(prev.payload, 'foreign_net') ?? 0) + (num(prev.payload, 'institution_net') ?? 0)
    : null;
  const read = computeIntradayRead(buckets, prevFlowSum);
  if (!read) return empty;

  const last = buckets[buckets.length - 1]!;
  const price = last.price;
  // 읽기의 lean을 방향으로 옮긴다. unclear/weak 구분은 방향이 아니라 강도라
  // 여기서는 support 부호만 본다.
  const dir: 'up' | 'down' | null =
    read.lean === 'supported' || read.lean === 'recovering'
      ? 'up'
      : read.lean === 'fading' || read.lean === 'weak'
        ? 'down'
        : null;
  const at = hhmm(now);
  const hourBucket = `${today}T${String(now.getUTCHours()).padStart(2, '0')}:00+09:00`;
  const result: IntradayRecordResult = {
    at,
    direction: dir,
    headline: read.headline,
    lanes: [],
  };
  if (!dir) {
    result.lanes.push(
      { kind: 'directional_h1', label: '1시간 뒤', recorded: false, reason: 'no_direction', prediction: null },
      { kind: 'directional_d0', label: '오늘 마감', recorded: false, reason: 'no_direction', prediction: null },
    );
    return result;
  }

  const context = {
    as_of: today,
    at,
    variant: 'intraday_read',
    lean: read.lean,
    price,
    factors: Object.fromEntries(read.factors.map((f) => [f.key, f.value])),
    caveats: read.caveats,
  };

  const plan: Array<{
    kind: IntradayLane['kind'];
    label: string;
    metric: string;
    field: string;
    bucket: string;
    inWindow: boolean;
  }> = [
    {
      kind: 'directional_h1',
      label: '1시간 뒤',
      metric: 'minute_bars',
      // 정확히 60분 뒤의 분. 분봉 배열 안에서 찾도록 field에 시각을 넣는다.
      field: hhmm(new Date(now.getTime() + 60 * 60_000)),
      bucket: `${today}T${String(new Date(now.getTime() + 60 * 60_000).getUTCHours()).padStart(2, '0')}:00+09:00`,
      inWindow: nowMin >= OPEN_MIN && nowMin <= H1_CUTOFF_MIN,
    },
    {
      kind: 'directional_d0',
      label: '오늘 마감',
      metric: 'daily_ohlcv',
      field: 'close',
      bucket: today,
      inWindow: nowMin >= OPEN_MIN && nowMin < CLOSE_MIN,
    },
  ];

  for (const p of plan) {
    if (!p.inWindow) {
      result.lanes.push({ kind: p.kind, label: p.label, recorded: false, reason: 'out_of_window', prediction: null });
      continue;
    }
    // 시간 버킷당 1건 — 온디맨드 수집이 겹쳐도 표본이 부풀지 않게 한다.
    const [dup] = await db
      .select({ id: stockPredictions.id })
      .from(stockPredictions)
      .where(
        and(
          eq(stockPredictions.symbol, symbol),
          eq(stockPredictions.kind, p.kind),
          sql`${stockPredictions.context} ->> 'hour_bucket' = ${hourBucket}`,
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
        authored_by: 'intraday-read',
        kind: p.kind,
        claim: `장중 읽기 ${dir === 'up' ? '상방' : '하방'} (${p.label}, ${at} 기준 ${price.toLocaleString('ko-KR')}원): ${read.headline}`,
        metric: p.metric,
        field: p.field,
        comparator: dir === 'up' ? 'gt' : 'lt',
        threshold: price,
        target_bucket: p.bucket,
        context: { ...context, hour_bucket: hourBucket, horizon: p.kind },
      });
      result.lanes.push({ kind: p.kind, label: p.label, recorded: true, reason: 'recorded', prediction: toApiPrediction(row) });
    } catch (e) {
      // 대상 버킷이 이미 있으면 결과를 아는 상태라 기록하지 않는다 (사후 예측 차단).
      if (e instanceof HttpError && e.status === 409) {
        result.lanes.push({ kind: p.kind, label: p.label, recorded: false, reason: 'post_hoc', prediction: null });
        continue;
      }
      throw e;
    }
  }
  return result;
}
