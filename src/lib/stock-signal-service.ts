import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions } from '@/db/schema';
import { createPrediction, toApiPrediction, type ApiPrediction } from './prediction-service';
import { HttpError } from './errors';
import {
  variantsFor,
  computeRegimeBreakdown,
  computeSignal,
  computeSignalBacktest,
  computeSignalSeries,
  HORIZONS,
  SIGNAL_VARIANTS,
  type ComponentSlice,
  type RegimeSlice,
  type HorizonKey,
  type RuleSignal,
  type SignalBacktest,
  type SignalSeriesPoint,
} from './stock-signal';
import {
  computeWeeklyChanges,
  trendWithWindows,
  type Bar,
  type Indicators,
  type Regime,
  type BenchmarkSeries,
  type Flow,
  type WeeklyChange,
} from './stock-indicators';
import { getMarketCalendar, nextTradingDay } from './market-calendar';
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
  /** 달력을 아는 범위를 넘어간 추정치인가 — 그러면 대상일이 휴장일일 수 있다 */
  beyond_known_calendar: boolean;
  /**
   * 대상 거래일이 **엄밀히 과거**인가 — 기준 봉이 낡았다는 뜻이다(마감 수집 누락 등).
   * 이 상태로 기록하면 결과를 이미 아는 채로 예측하는 꼴이라 기록을 건너뛴다.
   * 대상이 오늘이면 stale이 아니다 — 종가가 아직 안 나왔으므로 정상 예측이다.
   * (오늘 종가가 이미 확정된 경우는 createPrediction의 사후 차단이 잡는다.)
   */
  stale: boolean;
  /** 과거 재적용 성적 — 기저율과 함께만 인용할 것 */
  backtest: SignalBacktest;
  /** 통과한 신호의 실전 성적 — 이게 "규칙의 성적표"다 */
  live: DirectionalStats;
  /**
   * 게이트·임계값에 막힌 날의 실전 성적. 매매 참고가 아니라 게이트 검증용이다 —
   * 이 표본이 통과분보다 잘 맞으면 게이트가 틀렸다는 증거가 된다.
   */
  blocked: DirectionalStats;
  /** 병행 기록 중인 후보 규칙의 실전 성적 (없으면 null) */
  challengers: { key: string; label: string; live: DirectionalStats }[];
};

export type DirectionalStats = {
  pending: number;
  confirmed: number;
  refuted: number;
  expired: number;
  unverifiable: number;
  scored: number;
  hit_rate: number | null;
  /**
   * 이 레인이 **어느 쪽으로 얼마나 불렀나**. 적중률만으로는 안 보이는 것을 본다 —
   * 2026-08 `directional_1d`는 24건 전부 하방이었는데 적중률 35%라는 숫자는 그걸
   * 감췄다. `up_share`가 0이나 1이면 규칙이 한쪽에 갇혀 예측이 아니라 상수다.
   */
  calls: { n: number; up: number; down: number; up_share: number | null };
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
  /**
   * "어떤 장에서 어떤 규칙이 먹히나" — 국면별·컴포넌트별 분해 (5거래일 지평, 인샘플).
   * 게이트를 무시한 원시 방향 기준이다. 규칙 개선의 출발점이지 성적표가 아니다.
   */
  breakdown: { regimes: RegimeSlice[]; components: ComponentSlice[] };
};

/**
 * 내부 계산 결과 — 공개 응답에 **후보 규칙 재계산용 재료**를 덧붙인 것.
 *
 * 타입을 나눈 이유: bars는 320개짜리 배열이라 API 응답에 새어 나가면 페이로드가
 * 통째로 부풀고, 소비자가 그걸 믿고 쓰기 시작하면 되돌리기 어렵다. `getStockSignal`이
 * 좁은 타입을 돌려주므로 실수로 흘릴 수가 없다.
 */
type SignalComputation = SignalResult & {
  inputs: { indicators: Indicators | null; regime: Regime | null; bars: Bar[] };
};

function todayKst(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 지평별 실전 성적. `passed`로 두 레인을 가른다:
 * - `true`  — 게이트·임계값을 통과한 신호. 대시보드가 "실전 적중률"로 보여주는 것.
 * - `false` — 막힌 날. 매매 참고용이 아니라 **게이트를 검증하려고** 쌓는 표본이다.
 *
 * context가 없는 옛 행(2026-08-04 이전)은 전부 통과분이었으므로 passed 쪽으로 센다.
 */
async function directionalStats(
  symbol: string,
  kind: string,
  passed: boolean,
  /** 규칙 후보. 생략하면 현행(champion) — context에 variant가 없는 옛 행도 여기 든다. */
  variant: string = 'champion',
): Promise<DirectionalStats> {
  const passedExpr = passed
    ? sql`coalesce(${stockPredictions.context} ->> 'passed', 'true') = 'true'`
    : sql`${stockPredictions.context} ->> 'passed' = 'false'`;
  const variantExpr = sql`coalesce(${stockPredictions.context} ->> 'variant', 'champion') = ${variant}`;
  const rows = await db
    .select({
      status: stockPredictions.status,
      comparator: stockPredictions.comparator,
      n: sql<number>`count(*)::int`,
    })
    .from(stockPredictions)
    .where(
      and(
        eq(stockPredictions.symbol, symbol),
        eq(stockPredictions.kind, kind),
        passedExpr,
        variantExpr,
      ),
    )
    .groupBy(stockPredictions.status, stockPredictions.comparator);
  const count = (st: string) => rows.filter((r) => r.status === st).reduce((a, r) => a + r.n, 0);
  const confirmed = count('confirmed');
  const refuted = count('refuted');
  // 방향 균형은 **채점 여부와 무관하게** 센다 — 아직 대기 중인 예측도 "무슨 방향을
  // 냈는지"는 이미 정해져 있고, 한쪽 쏠림은 그 표본까지 넣어야 빨리 드러난다.
  const up = rows.filter((r) => r.comparator === 'gt').reduce((a, r) => a + r.n, 0);
  const down = rows.filter((r) => r.comparator !== 'gt').reduce((a, r) => a + r.n, 0);
  return {
    pending: count('pending'),
    confirmed,
    refuted,
    expired: count('expired'),
    unverifiable: count('unverifiable'),
    scored: confirmed + refuted,
    hit_rate:
      confirmed + refuted > 0 ? Number((confirmed / (confirmed + refuted)).toFixed(3)) : null,
    calls: {
      n: up + down,
      up,
      down,
      up_share: up + down > 0 ? Number((up / (up + down)).toFixed(3)) : null,
    },
  };
}


const num = (payload: unknown, key: string): number => {
  const v = Number((payload as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) ? v : NaN;
};

/** 신호 계산 + directional 적중률 + 주간 관점(점수 시계열·백테스트). **부작용 없음**. */
export async function getStockSignal(symbol: string): Promise<SignalResult> {
  const { inputs: _drop, ...pub } = await computeSignalResult(symbol);
  return pub;
}

async function computeSignalResult(symbol: string): Promise<SignalComputation> {
  const { indicators, regime } = await getStockRegime(symbol);
  const signal = computeSignal(indicators, regime);

  const [ohlcv, flowRows, soxRows, calendar] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', 320),
    getStockHistory(symbol, 'investor_flow', 60),
    getStockHistory(symbol, 'benchmark_sox', 320),
    getMarketCalendar(symbol),
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
    // 미국장이라 D일 종가를 D일에 쓸 수 없다 — 재현 시 하루 미뤄 맞춘다
    overnight: true,
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
      // 거래일을 센다 — 캘린더 날짜를 더하는 게 아니다. 휴장일이 끼면 달라진다.
      const { date: target, beyondKnown } = nextTradingDay(asOf, h.trading_days, calendar);
      return {
        key: h.key,
        label: h.label,
        trading_days: h.trading_days,
        target_bucket: target,
        beyond_known_calendar: beyondKnown,
        stale: target < today,
        backtest: computeSignalBacktest(series, bars, h.trading_days),
        live: await directionalStats(symbol, h.kind, true),
        blocked: await directionalStats(symbol, h.kind, false),
        challengers: await Promise.all(
          variantsFor(h.key)
            .filter((v) => v.key !== 'champion')
            .map(async (v) => ({
              key: v.key,
              label: v.label,
              live: await directionalStats(symbol, h.kind, true, v.key),
            })),
        ),
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
    breakdown: computeRegimeBreakdown(series, bars, 5),
    inputs: { indicators, regime, bars },
  };
}

export type RecordReason =
  | 'recorded'
  /** (더는 쓰지 않음 — 게이트 차단분도 기록한다. 옛 응답 호환용) */
  | 'watch_signal'
  | 'no_signal'
  | 'already_pending'
  | 'no_reference'
  /** score 0 — 방향이 없어 반증 불가능하다 */
  | 'no_direction'
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
  const res = await computeSignalResult(symbol);
  const fail = (reason: RecordReason): RecordResult => ({
    recorded: false,
    reason,
    prediction: null,
    signal: res.signal,
    lanes: [],
  });
  if (!res.signal) return { ...fail('no_signal'), signal: null };
  // score 0은 방향이 없어 반증 불가능하다 — 이때만 기록을 건너뛴다.
  // 게이트에 막힌 날(passed=false)은 **기록한다**: 막힌 날의 결과를 모르면 게이트가
  // 옳았는지 실전 데이터로 영영 판정할 수 없다.
  if (!res.signal.raw_direction) return fail('no_direction');
  if (res.reference_close === null || !res.as_of) return fail('no_reference');

  const dir = res.signal.raw_direction;
  const sig = res.signal;
  const refClose = res.reference_close;
  const asOf = res.as_of;
  const lanes: RecordResult['lanes'] = [];

  // (지평 × 규칙 후보). 후보마다 붙는 지평이 다르다 — 추세 창만 바꾸는 후보는 창이
  // 같은 5거래일에 붙여봐야 같은 예측을 두 번 남길 뿐이다 (variantsFor 참고).
  const jobs = HORIZONS.flatMap((h) => variantsFor(h.key).map((v) => ({ h, v })));

  for (const { h, v } of jobs) {
    // champion은 이미 계산된 신호를 그대로 쓴다. 후보는 바꾸는 것에 따라 다시 판정한다 —
    // 창을 바꾸는 후보는 추세만, 규칙을 바꾸는 후보는 컴포넌트 구성 자체를.
    const hasRules = Object.keys(v.rules).length > 0;
    const vSig =
      v.trend_windows === null && !hasRules
        ? sig
        : computeSignal(res.inputs.indicators, res.inputs.regime, {
            ...(v.trend_windows === null
              ? {}
              : {
                  trend: trendWithWindows(
                    res.inputs.bars,
                    v.trend_windows.short,
                    v.trend_windows.long,
                  ),
                  trendReason: `${v.label} 기준 추세`,
                }),
            rules: v.rules,
          });
    const vDir = vSig?.raw_direction;
    const label = v.key === 'champion' ? h.label : `${h.label} · ${v.label}`;
    if (!vSig || !vDir) {
      lanes.push({
        horizon: h.key,
        label,
        recorded: false,
        reason: 'no_direction',
        prediction: null,
      });
      continue;
    }

    const view = res.horizons.find((x) => x.key === h.key)!;
    const bucket = view.target_bucket;
    if (view.stale) {
      lanes.push({
        horizon: h.key,
        label,
        recorded: false,
        reason: 'stale_reference',
        prediction: null,
      });
      continue;
    }
    // 중복 판정에 **후보 축이 들어가야 한다** — 없으면 champion이 먼저 기록된 뒤
    // 후보가 "이미 있음"으로 막혀서 병행 기록 자체가 성립하지 않는다.
    const [dup] = await db
      .select({ id: stockPredictions.id })
      .from(stockPredictions)
      .where(
        and(
          eq(stockPredictions.symbol, symbol),
          eq(stockPredictions.kind, h.kind),
          eq(stockPredictions.targetBucket, bucket),
          eq(stockPredictions.status, 'pending'),
          sql`coalesce(${stockPredictions.context} ->> 'variant', 'champion') = ${v.key}`,
        ),
      )
      .limit(1);
    if (dup) {
      lanes.push({
        horizon: h.key,
        label,
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
        claim: `규칙 ${vDir} (${label}, ${vSig.passed ? '신호 발효' : '게이트 차단 — 검증용'}): ${bucket} 종가가 기준(${asOf} 종가 ${refClose.toLocaleString('ko-KR')}원)보다 ${vDir === 'buy' ? '높은지' : '낮은지'} — score ${vSig.score}/${vSig.max_score}, 변동성 ${vSig.volatility}`,
        context: {
          // 어느 규칙 후보가 낸 예측인지. 없으면 현행(champion)으로 센다.
          variant: v.key,
          // 기준 봉의 거래일. created_at에서 유추하면 안 된다 — 마감 전에 기록되면
          // 기록일과 기준 봉이 하루 어긋나고, 장부가 "8/4 마감에 → 8/4 판가름" 같은
          // 말이 안 되는 문장을 만든다 (2026-08-04 실제 발생).
          as_of: asOf,
          score: vSig.score,
          passed: vSig.passed,
          gated: vSig.gated_by_volatility,
          applied_threshold: vSig.applied_threshold,
          volatility: vSig.volatility,
          // 국면·컴포넌트를 박제해야 나중에 "어떤 장에서 무엇이 먹혔나"를 되물을 수 있다
          components: Object.fromEntries(vSig.components.map((c) => [c.key, c.value])),
        },
        metric: 'daily_ohlcv',
        field: 'close',
        comparator: vDir === 'buy' ? 'gt' : 'lt',
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
      label,
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
