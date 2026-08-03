import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions } from '@/db/schema';
import { createPrediction, toApiPrediction, type ApiPrediction } from './prediction-service';
import {
  computeSignal,
  computeSignalSeries,
  type RuleSignal,
  type SignalBacktest,
  type SignalSeriesPoint,
} from './stock-signal';
import {
  computeWeeklyChanges,
  type Bar,
  type BenchmarkSeries,
  type Flow,
  type WeeklyChange,
} from './stock-indicators';
import { getStockRegime } from './stock-regime-service';
import { getStockHistory } from './stock-service';
import { HttpError } from './errors';

/** 신호 검증 지평: 약 5거래일 ≈ 달력 7일 (주말이면 다음 평일로 민다). */
const HORIZON_CALENDAR_DAYS = 7;

export type DirectionalStats = {
  pending: number;
  confirmed: number;
  refuted: number;
  expired: number;
  unverifiable: number;
  scored: number;
  hit_rate: number | null;
};

export type SignalResult = {
  symbol: string;
  as_of: string | null; // 기준 종가의 거래일
  reference_close: number | null;
  signal: RuleSignal | null;
  /** 신호가 채점될 조건 (buy/sell일 때만 의미) */
  target: { bucket: string; comparator: 'gt' | 'lt' | null } | null;
  directional: DirectionalStats;
  /** 주 단위 등락 (마지막 확정 종가 기준) */
  weekly: WeeklyChange[];
  /** 규칙 점수를 과거에 재적용한 시계열 (최근 90거래일) */
  score_series: SignalSeriesPoint[];
  /** 인샘플 백테스트 — 실전 성적 아님. note 문구와 함께만 인용할 것. */
  backtest: SignalBacktest;
};

function kstDatePlus(days: number): string {
  const d = new Date(Date.now() + 9 * 3_600_000 + days * 86_400_000);
  // 주말이면 다음 평일로. KRX 공휴일은 모른다 — 그 경우 채점기가 expired 처리한다.
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function directionalStats(symbol: string): Promise<DirectionalStats> {
  const rows = await db
    .select({ status: stockPredictions.status, n: sql<number>`count(*)::int` })
    .from(stockPredictions)
    .where(
      and(eq(stockPredictions.symbol, symbol), eq(stockPredictions.kind, 'directional')),
    )
    .groupBy(stockPredictions.status);
  const count = (st: string) => rows.find((r) => r.status === st)?.n ?? 0;
  const confirmed = count('confirmed');
  const refuted = count('refuted');
  return {
    pending: count('pending'),
    confirmed,
    refuted,
    expired: count('expired'),
    unverifiable: count('unverifiable'),
    scored: confirmed + refuted,
    hit_rate:
      confirmed + refuted > 0 ? Number((confirmed / (confirmed + refuted)).toFixed(3)) : null,
  };
}

const num = (payload: unknown, key: string): number => {
  const v = Number((payload as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) ? v : NaN;
};

/** 신호 계산 + directional 적중률 + 주간 관점(점수 시계열·백테스트). **부작용 없음**. */
export async function getStockSignal(symbol: string): Promise<SignalResult> {
  const { indicators, regime } = await getStockRegime(symbol);
  const signal = computeSignal(indicators, regime);

  const [ohlcv, flowRows, soxRows] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', 320),
    getStockHistory(symbol, 'investor_flow', 60),
    getStockHistory(symbol, 'benchmark_sox', 320),
  ]);
  const bars: Bar[] = ohlcv
    .map((r) => ({
      date: r.bucketKey,
      close: num(r.payload, 'close'),
      high: num(r.payload, 'high'),
      low: num(r.payload, 'low'),
      volume: num(r.payload, 'volume'),
    }))
    .filter((b) => Number.isFinite(b.close));
  const flows: Flow[] = flowRows
    .map((r) => ({
      date: r.bucketKey,
      foreign: num(r.payload, 'foreign_net'),
      institution: num(r.payload, 'institution_net'),
      individual: num(r.payload, 'individual_net'),
    }))
    .filter((f) => Number.isFinite(f.foreign));
  const sox: BenchmarkSeries = {
    key: 'sox',
    label: '필라델피아 반도체(SOX)',
    containsStock: false,
    bars: soxRows
      .map((r) => ({ date: r.bucketKey, close: num(r.payload, 'close') }))
      .filter((x) => Number.isFinite(x.close) && x.close > 0),
  };
  const { series, backtest } = computeSignalSeries(bars, flows, [sox]);

  const latest = ohlcv[ohlcv.length - 1];
  const close = latest ? num(latest.payload, 'close') : NaN;

  const bucket = kstDatePlus(HORIZON_CALENDAR_DAYS);
  return {
    symbol,
    as_of: latest?.bucketKey ?? null,
    reference_close: Number.isFinite(close) ? close : null,
    signal,
    target:
      signal && signal.signal !== 'watch'
        ? { bucket, comparator: signal.signal === 'buy' ? 'gt' : 'lt' }
        : signal
          ? { bucket, comparator: null }
          : null,
    directional: await directionalStats(symbol),
    weekly: computeWeeklyChanges(bars, 8),
    score_series: series.slice(-90),
    backtest,
  };
}

export type RecordResult = {
  recorded: boolean;
  reason: 'recorded' | 'watch_signal' | 'no_signal' | 'already_pending' | 'no_reference';
  prediction: ApiPrediction | null;
  signal: RuleSignal | null;
};

/**
 * 오늘 신호를 directional 예측으로 **기록**한다 (마감 수집 후 하루 1회 용도).
 * watch는 반증 불가능하므로 기록하지 않는다. 같은 대상 버킷에 pending directional이
 * 이미 있으면 중복 기록하지 않는다 — 하루에 여러 번 불려도 안전하다.
 */
export async function recordStockSignal(symbol: string): Promise<RecordResult> {
  const res = await getStockSignal(symbol);
  if (!res.signal) return { recorded: false, reason: 'no_signal', prediction: null, signal: null };
  if (res.signal.signal === 'watch') {
    return { recorded: false, reason: 'watch_signal', prediction: null, signal: res.signal };
  }
  if (res.reference_close === null || !res.as_of) {
    return { recorded: false, reason: 'no_reference', prediction: null, signal: res.signal };
  }

  const bucket = res.target!.bucket;
  const [dup] = await db
    .select({ id: stockPredictions.id })
    .from(stockPredictions)
    .where(
      and(
        eq(stockPredictions.symbol, symbol),
        eq(stockPredictions.kind, 'directional'),
        eq(stockPredictions.targetBucket, bucket),
        eq(stockPredictions.status, 'pending'),
      ),
    )
    .limit(1);
  if (dup) {
    return { recorded: false, reason: 'already_pending', prediction: null, signal: res.signal };
  }

  const dir = res.signal.signal;
  try {
    const row = await createPrediction({
      symbol,
      analysis_id: null,
      authored_by: 'rule-signal',
      kind: 'directional',
      claim: `규칙 신호 ${dir}: ${bucket} 종가가 기준(${res.as_of} 종가 ${res.reference_close.toLocaleString('ko-KR')}원)보다 ${dir === 'buy' ? '높은지' : '낮은지'} — score ${res.signal.score}/${res.signal.max_score}`,
      metric: 'daily_ohlcv',
      field: 'close',
      comparator: dir === 'buy' ? 'gt' : 'lt',
      threshold: res.reference_close,
      target_bucket: bucket,
    });
    return { recorded: true, reason: 'recorded', prediction: toApiPrediction(row), signal: res.signal };
  } catch (e) {
    // 409(already_observable)는 지평 계산이 과거를 가리킨 것 — 버그이므로 그대로 던진다.
    if (e instanceof HttpError) throw e;
    throw e;
  }
}
