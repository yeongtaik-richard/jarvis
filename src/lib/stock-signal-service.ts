import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions } from '@/db/schema';
import { createPrediction, toApiPrediction, type ApiPrediction } from './prediction-service';
import { HttpError } from './errors';
import {
  computeSignal,
  computeSignalBacktest,
  computeSignalSeries,
  HORIZONS,
  type HorizonKey,
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

/**
 * 지평별 뷰 — 규칙과 점수는 하나고, 다른 건 "언제 확인하느냐"뿐이다.
 * 인샘플 백테스트(과거 재적용)와 실전 표본(실제 기록·채점)을 나란히 둔다.
 */
export type HorizonView = {
  key: HorizonKey;
  label: string;
  trading_days: number;
  /** 이 지평의 신호가 채점될 거래일 (기준 봉 as_of 기준) */
  target_bucket: string;
  /**
   * 대상 거래일이 **엄밀히 과거**인가 — 기준 봉이 낡았다는 뜻이다(마감 수집 누락 등).
   * 이 상태로 기록하면 결과를 이미 아는 채로 예측하는 꼴이라 기록을 건너뛴다.
   * 대상이 오늘이면 stale이 아니다 — 종가가 아직 안 나왔으므로 정상 예측이다.
   * (오늘 종가가 이미 확정된 경우는 createPrediction의 사후 차단이 잡는다.)
   */
  stale: boolean;
  /** 과거 재적용 성적 — 기저율과 함께만 인용할 것 */
  backtest: SignalBacktest;
  /** 실제로 기록되고 채점된 성적 */
  live: DirectionalStats;
};

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
  /** 5거래일 레인의 실전 성적 (하위호환 — horizons[].live를 쓰는 게 낫다) */
  directional: DirectionalStats;
  /** 하루·일주일 두 지평. 같은 신호를 다른 시점에 채점한 결과다. */
  horizons: HorizonView[];
  /** 주 단위 등락 (마지막 확정 종가 기준) */
  weekly: WeeklyChange[];
  /** 규칙 점수를 과거에 재적용한 시계열 (최근 90거래일) */
  score_series: SignalSeriesPoint[];
};

/**
 * 기준 거래일 + N일 → 대상 거래일. **"오늘"이 아니라 기준 봉에서 잰다** — 백테스트는
 * 신호일 종가를 진입점으로 채점하는데 기록만 오늘 기준이면 둘이 다른 걸 재게 된다.
 * 주말이면 다음 평일로. KRX 공휴일은 모른다 — 그 경우 채점기가 expired 처리한다.
 */
function tradingDayAfter(baseDate: string, days: number): string {
  const d = new Date(`${baseDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function todayKst(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

async function directionalStats(symbol: string, kind: string): Promise<DirectionalStats> {
  const rows = await db
    .select({ status: stockPredictions.status, n: sql<number>`count(*)::int` })
    .from(stockPredictions)
    .where(and(eq(stockPredictions.symbol, symbol), eq(stockPredictions.kind, kind)))
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
  const latest = ohlcv[ohlcv.length - 1];
  const close = latest ? num(latest.payload, 'close') : NaN;
  const asOf = latest?.bucketKey ?? todayKst();
  const today = todayKst();

  // 시계열은 한 번만 만들고 지평별 백테스트에 재사용한다 (재계산은 O(n²)).
  const { series } = computeSignalSeries(bars, flows, [sox]);
  const horizons: HorizonView[] = await Promise.all(
    HORIZONS.map(async (h) => {
      const target = tradingDayAfter(asOf, h.calendar_days);
      return {
        key: h.key,
        label: h.label,
        trading_days: h.trading_days,
        target_bucket: target,
        stale: target < today,
        backtest: computeSignalBacktest(series, bars, h.trading_days),
        live: await directionalStats(symbol, h.kind),
      };
    }),
  );

  const bucket = horizons.find((h) => h.key === 'd5')!.target_bucket;
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
    directional: horizons.find((h) => h.key === 'd5')!.live,
    horizons,
    weekly: computeWeeklyChanges(bars, 8),
    score_series: series.slice(-90),
  };
}

export type RecordReason =
  | 'recorded'
  | 'watch_signal'
  | 'no_signal'
  | 'already_pending'
  | 'no_reference'
  /** 기준 봉이 낡아 대상 거래일이 이미 지났다 — 사후 예측이 되므로 기록하지 않는다 */
  | 'stale_reference';

export type RecordResult = {
  recorded: boolean;
  /** 지평이 하나라도 기록됐으면 'recorded' — 자세한 건 lanes */
  reason: RecordReason;
  /** 하위호환: 첫 기록분 */
  prediction: ApiPrediction | null;
  signal: RuleSignal | null;
  lanes: Array<{
    horizon: HorizonKey;
    label: string;
    recorded: boolean;
    reason: RecordReason;
    prediction: ApiPrediction | null;
  }>;
};

/**
 * 오늘 신호를 **지평별로** directional 예측에 기록한다 (마감 수집 후 하루 1회 용도).
 *
 * 두 레인은 독립이다 — 하루 지평은 매 거래일 새 대상 버킷이 생기므로 거의 매일 기록되고,
 * 일주일 지평은 같은 버킷을 가리키는 동안 중복 기록되지 않는다. 이 비대칭이 의도다:
 * 하루 레인이 표본을 빨리 쌓아 실전 검증을 앞당긴다.
 *
 * watch는 반증 불가능하므로 기록하지 않는다. 같은 (kind, 대상 버킷)에 pending이 이미
 * 있으면 건너뛴다 — 하루에 여러 번 불려도 안전하다.
 */
export async function recordStockSignal(symbol: string): Promise<RecordResult> {
  const res = await getStockSignal(symbol);
  const fail = (reason: RecordReason): RecordResult => ({
    recorded: false,
    reason,
    prediction: null,
    signal: res.signal,
    lanes: [],
  });
  if (!res.signal) return { ...fail('no_signal'), signal: null };
  if (res.signal.signal === 'watch') return fail('watch_signal');
  if (res.reference_close === null || !res.as_of) return fail('no_reference');

  const dir = res.signal.signal;
  const refClose = res.reference_close;
  const asOf = res.as_of;
  const lanes: RecordResult['lanes'] = [];

  for (const h of HORIZONS) {
    const view = res.horizons.find((v) => v.key === h.key)!;
    const bucket = view.target_bucket;
    if (view.stale) {
      lanes.push({
        horizon: h.key,
        label: h.label,
        recorded: false,
        reason: 'stale_reference',
        prediction: null,
      });
      continue;
    }
    const [dup] = await db
      .select({ id: stockPredictions.id })
      .from(stockPredictions)
      .where(
        and(
          eq(stockPredictions.symbol, symbol),
          eq(stockPredictions.kind, h.kind),
          eq(stockPredictions.targetBucket, bucket),
          eq(stockPredictions.status, 'pending'),
        ),
      )
      .limit(1);
    if (dup) {
      lanes.push({
        horizon: h.key,
        label: h.label,
        recorded: false,
        reason: 'already_pending',
        prediction: null,
      });
      continue;
    }

    // 사후 차단(409)에 걸리면 그 레인만 접고 다른 지평은 계속 간다 — 한 레인의
    // 타이밍 문제로 나머지 기록까지 잃을 이유가 없다.
    let row;
    try {
      row = await createPrediction({
        symbol,
        analysis_id: null,
        authored_by: 'rule-signal',
        kind: h.kind,
        claim: `규칙 신호 ${dir} (${h.label} 지평): ${bucket} 종가가 기준(${asOf} 종가 ${refClose.toLocaleString('ko-KR')}원)보다 ${dir === 'buy' ? '높은지' : '낮은지'} — score ${res.signal.score}/${res.signal.max_score}`,
        metric: 'daily_ohlcv',
        field: 'close',
        comparator: dir === 'buy' ? 'gt' : 'lt',
        threshold: refClose,
        target_bucket: bucket,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        lanes.push({
          horizon: h.key,
          label: h.label,
          recorded: false,
          reason: 'stale_reference',
          prediction: null,
        });
        continue;
      }
      throw e;
    }
    lanes.push({
      horizon: h.key,
      label: h.label,
      recorded: true,
      reason: 'recorded',
      prediction: toApiPrediction(row),
    });
  }

  const first = lanes.find((l) => l.recorded);
  return {
    recorded: Boolean(first),
    reason: first ? 'recorded' : (lanes[0]?.reason ?? 'already_pending'),
    prediction: first?.prediction ?? null,
    signal: res.signal,
    lanes,
  };
}
