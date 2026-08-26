/**
 * 규칙 기반 방향성 신호. **미검증이며, 매매 지시가 아니다.**
 *
 * 정직성 규칙과의 관계 (docs/stock.md §정직성):
 * - AI 자유 텍스트(브리핑)에는 여전히 매수/매도가 금지다. 방향성은 **이 결정론적
 *   레인에서만** 나오고, 항상 미검증 라벨과 directional 적중률 표본이 따라붙는다.
 * - 신호는 발행 시점에 `stock_predictions(kind='directional')`로 기록돼 기존 채점기가
 *   자동으로 confirmed/refuted를 정산한다. 이 표본이 쌓여야 `validated_directional`
 *   해금 논의가 가능하다 — 해금 자체는 리처드가 결정한다.
 *
 * 규칙은 전부 이 파일의 상수다. 바꾸면 신호가 바뀌므로 커밋에 근거를 남길 것.
 */

import {
  classifyRegime,
  computeIndicators,
  type Bar,
  type BenchmarkSeries,
  type Flow,
  type Indicators,
  type Regime,
  type Trend,
} from './stock-indicators';

export type SignalValue = 'buy' | 'sell' | 'watch';

/** 화면에 영문 라벨이 새어 나가지 않게 — 'down'을 그대로 보여주면 안 된다. */
const TREND_WORD: Record<string, string> = {
  up: '상승 추세',
  down: '하락 추세',
  sideways: '횡보',
  unknown: '판단 불가',
};

export type ComponentKey =
  | 'trend'
  | 'flow'
  | 'relative_sox'
  /** 추세를 쪼갠 두 조각 — splitTrend 규칙에서만 나온다 */
  | 'trend_position'
  | 'trend_structure'
  /** 기관 수급 — institutionFlow 규칙에서만 나온다 */
  | 'flow_institution';

export interface SignalComponent {
  key: ComponentKey;
  value: -1 | 0 | 1;
  reason: string;
}

/**
 * 규칙 후보가 바꾸는 것들. 비어 있으면 현행(champion)이다.
 *
 * ## splitTrend — 왜 쪼개나
 * 현행 추세는 `종가가 MA20보다 +3% 위` **AND** `MA20 > MA60`일 때만 'up'이다. 둘은
 * 서로 다른 정보인데 AND로 묶여 한쪽이 다른 쪽을 삼킨다. 2026-08-25 실측이 그 결과다:
 * 종가가 MA20보다 **+7.4% 위**인데 MA20이 MA60보다 22.8% 아래라 판정이 '횡보'(0)였다.
 * MA60은 7월 폭락 전 가격을 물고 있어 몇 주간 회복되지 않는다.
 *
 * 그래서 `directional_1d`는 2026-08-04~08-25 24건이 **전부 하방**이었다. 그동안 주가는
 * 08-07 1,422,000 → 08-21 1,730,000으로 +21.7% 올랐다. 틀린 예측이 아니라 예측이
 * 아니었다 — 한쪽만 나오는 규칙은 상수다.
 *
 * ## institutionFlow — 왜 더하나
 * 수급 컴포넌트가 외국인만 본다. 같은 날 외국인이 20일간 5.03조를 파는 동안 기관은
 * 1.04조를 샀는데, 그 정보가 통째로 버려졌다.
 */
export interface SignalRules {
  splitTrend?: boolean;
  institutionFlow?: boolean;
}

export interface RuleSignal {
  /** 게이트·임계값을 **통과한** 최종 신호. 매매 참고는 이것만 본다. */
  signal: SignalValue;
  /**
   * 점수 부호가 가리키는 원시 방향 (임계값·게이트 무시). |score|가 1이어도 방향은 있다.
   * 이걸 노출하는 이유는 하나뿐이다 — 게이트가 막은 날도 기록해서 **게이트 자체를
   * 실전 데이터로 검증**하기 위해서다. 매매 판단에 쓰라고 있는 값이 아니다.
   */
  raw_direction: Exclude<SignalValue, 'watch'> | null;
  /** 최종 신호가 임계값·게이트를 통과했는가 (= signal !== 'watch') */
  passed: boolean;
  /** 이 판정에 적용된 임계값 (변동성 극단이면 3, 아니면 2) */
  applied_threshold: number;
  /** 판정 시점의 변동성 국면 — 게이트 검증 때 슬라이스 기준이 된다 */
  volatility: string;
  /** 컴포넌트 합. [-3, +3] */
  score: number;
  max_score: number;
  components: SignalComponent[];
  /** 변동성 극단 구간에서 임계 미달로 watch로 강등됐는가 */
  gated_by_volatility: boolean;
  disclaimer: string;
}

/**
 * 임계값은 **컴포넌트 수에 비례**한다. 후보마다 컴포넌트 개수가 달라서 절대값으로 두면
 * 5개짜리 규칙이 3개짜리보다 훨씬 무르게 발효된다.
 *
 * 비율은 현행 3컴포넌트 규칙의 임계(2, 극단 3)를 그대로 재현하도록 잡았다 —
 * ceil(3 × 2/3) = 2, ceil(3 × 0.8) = 3. **champion의 동작은 한 톨도 안 바뀐다.**
 */
const THRESHOLD_RATIO = 2 / 3;
/** 변동성 극단(≥90%ile)에서는 거의 만장일치일 때만 — 급등락 구간의 신호는 신뢰도가 낮다. */
const EXTREME_THRESHOLD_RATIO = 0.8;
const thresholdFor = (maxScore: number, extreme: boolean): number =>
  Math.max(1, Math.ceil(maxScore * (extreme ? EXTREME_THRESHOLD_RATIO : THRESHOLD_RATIO)));

/** SOX 대비 20일 초과수익이 이 %p를 넘어야 상대강도 컴포넌트가 켜진다. */
const RS_EXCESS_PCT = 5;
/** 종가가 MA20에서 이 % 밖이어야 위치 컴포넌트가 켜진다 (현행 추세 규칙과 같은 폭). */
const MA20_POS_PCT = 3;
/** MA20과 MA60이 이 % 넘게 벌어져야 배열 컴포넌트가 켜진다 — 붙어 있으면 방향이 없다. */
const MA_STACK_PCT = 1;
/** 수급 컴포넌트가 켜지려면 같은 방향이 이만큼 이어져야 한다. */
const FLOW_STREAK_MIN = 2;

// 화면의 "미검증 · 실전 표본" 배지와 지평 표가 이미 표본·기저율을 보여주므로,
// 여기서는 그 둘이 못 하는 말만 한다 — 이건 규칙의 출력이지 매매 지시가 아니라는 것.
export const SIGNAL_DISCLAIMER =
  '정해진 규칙이 계산한 값이다. 사라거나 팔라는 뜻이 아니다.';

export function computeSignal(
  ind: Indicators | null,
  regime: Regime | null,
  /** 추세 창 교체(trend/trendReason)와 규칙 후보(rules). SIGNAL_VARIANTS 참고. */
  opts?: { trend?: Trend; trendReason?: string; rules?: SignalRules },
): RuleSignal | null {
  if (!ind || !regime) return null;

  const rules = opts?.rules ?? {};
  const components: SignalComponent[] = [];
  const trend = opts?.trend ?? regime.trend;

  if (rules.splitTrend) {
    // 1a) 위치 — 종가가 20일 평균선의 어느 쪽에 있나. 반등을 즉시 읽는다.
    const dist = ind.dist_ma20_pct;
    components.push({
      key: 'trend_position',
      value: dist === null ? 0 : dist > MA20_POS_PCT ? 1 : dist < -MA20_POS_PCT ? -1 : 0,
      reason:
        dist === null
          ? '20일 평균선을 만들 데이터가 없다'
          : `종가가 20일 평균선보다 ${Math.abs(dist)}% ${dist > 0 ? '높다' : '낮다'}`,
    });
    // 1b) 배열 — MA20이 MA60 위인가. 회복이 굳었는지를 본다. 위치보다 느리다.
    const gap =
      ind.ma20 !== null && ind.ma60 !== null && ind.ma60 !== 0
        ? (ind.ma20 / ind.ma60 - 1) * 100
        : null;
    components.push({
      key: 'trend_structure',
      value: gap === null ? 0 : gap > MA_STACK_PCT ? 1 : gap < -MA_STACK_PCT ? -1 : 0,
      reason:
        gap === null
          ? '평균선 배열을 볼 데이터가 없다'
          : `20일 평균선이 60일 평균선보다 ${Math.abs(gap).toFixed(1)}% ${gap > 0 ? '위에 있다' : '아래에 있다'}`,
    });
  } else {
    // 1) 추세 — regime의 보수적 판정을 그대로 쓴다 (가격·MA 배열이 일치할 때만 방향).
    components.push({
      key: 'trend',
      value: trend === 'up' ? 1 : trend === 'down' ? -1 : 0,
      reason:
        opts?.trendReason ??
        (trend === 'unknown'
          ? '추세를 판단할 만큼 데이터가 없다'
          : `${TREND_WORD[trend] ?? trend} — 20일 평균선 대비 ${ind.dist_ma20_pct ?? '?'}%`),
    });
  }

  // 2) 수급 — 외국인 20일 누적과 연속 방향이 일치할 때만 방향.
  components.push({
    key: 'flow',
    value: regime.flow === 'foreign_buying' ? 1 : regime.flow === 'foreign_selling' ? -1 : 0,
    reason:
      regime.flow === 'mixed'
        ? '외국인 수급이 엇갈린다 — 20일 누적 방향과 최근 며칠 방향이 다르다'
        : regime.flow === 'unknown'
          ? '수급을 판단할 만큼 데이터가 없다'
          : `외국인이 ${Math.abs(ind.foreign_streak_days)}거래일 연속 ${regime.flow === 'foreign_buying' ? '사들이고' : '팔고'} 있다`,
  });

  if (rules.institutionFlow) {
    // 2b) 기관 수급 — 외국인과 같은 규칙(20일 누적 부호 + 연속일)을 기관에 적용한다.
    const net = ind.institution_net_20d;
    const st = ind.institution_streak_days;
    const enough = Math.abs(st) >= FLOW_STREAK_MIN;
    components.push({
      key: 'flow_institution',
      value: net === null ? 0 : net > 0 && enough && st > 0 ? 1 : net < 0 && enough && st < 0 ? -1 : 0,
      reason:
        net === null
          ? '기관 수급 데이터가 없다'
          : `기관이 20일 동안 ${(Math.abs(net) / 1_000_000).toFixed(2)}조 ${net > 0 ? '샀다' : '팔았다'} · 최근 ${Math.abs(st)}거래일 연속 ${st > 0 ? '순매수' : st < 0 ? '순매도' : '방향 없음'}`,
    });
  }

  // 3) 상대강도 — 종목이 안 들어간 벤치마크(SOX)만 쓴다. 오염 지수는 신호에 넣지 않는다.
  const sox = ind.relative.find((r) => r.key === 'sox' && !r.contains_stock);
  const rsExcess = sox?.excess_20d ?? null;
  components.push({
    key: 'relative_sox',
    value:
      rsExcess === null ? 0 : rsExcess > RS_EXCESS_PCT ? 1 : rsExcess < -RS_EXCESS_PCT ? -1 : 0,
    reason:
      rsExcess === null
        ? '미국 반도체 지수와 비교할 데이터가 없다'
        : `미국 반도체 지수(SOX)보다 20일간 ${rsExcess > 0 ? '더 올랐다' : '더 내렸다'} (차이 ${Math.abs(rsExcess)}%p)`,
  });

  const score = components.reduce((a, c) => a + c.value, 0);
  const maxScore = components.length;
  const extreme = regime.volatility === 'extreme';
  const threshold = thresholdFor(maxScore, extreme);
  const normalThreshold = thresholdFor(maxScore, false);

  let signal: SignalValue = 'watch';
  if (score >= threshold) signal = 'buy';
  else if (score <= -threshold) signal = 'sell';

  const gated = extreme && Math.abs(score) >= normalThreshold && Math.abs(score) < threshold;

  return {
    signal,
    raw_direction: score > 0 ? 'buy' : score < 0 ? 'sell' : null,
    passed: signal !== 'watch',
    applied_threshold: threshold,
    volatility: regime.volatility,
    score,
    max_score: components.length,
    components,
    gated_by_volatility: gated,
    disclaimer: SIGNAL_DISCLAIMER,
  };
}

// ── 검증 지평 ──────────────────────────────────────────────────────────

/**
 * 같은 규칙을 **두 지평으로 채점**한다. 규칙도 점수도 하나다 — 다른 건 "언제 확인하느냐"뿐.
 *
 * 왜 둘인가: 하루 지평은 표본이 5배 빨리 쌓여(매 거래일 1건) 실전 검증이 빨리 되고,
 * 일주일 지평은 국면·수급 지표의 창(20~60일)과 스케일이 맞는다. 2026-08-04 인샘플
 * 측정에서 하루 쪽 엣지가 더 컸지만(+7.2%p vs +4.9%p) 표본이 같은 63건이라 우열을
 * 단정할 수 없다 — 그래서 둘 다 노출하고 실전 표본으로 판정한다.
 *
 * `kind`는 예측 레코드의 kind 값이다. 'directional'이 5거래일인 건 역사적 이유다
 * (이 레인이 먼저 있었고, 기존 행을 갈아엎지 않으려고 접미사를 붙이지 않았다).
 *
 * 대상일은 `market-calendar.ts`의 `nextTradingDay`로 **거래일을 세어** 정한다.
 * 예전엔 캘린더 +1/+7일로 근사했는데, 휴장일이 끼면 백테스트(정확히 N거래일)와
 * 다른 구간을 재게 된다. 2026-08-17(광복절 대체휴일)이 실제로 그 사례가 될 뻔했다.
 */
export const HORIZONS = [
  { key: 'd1', kind: 'directional_1d', label: '하루', trading_days: 1 },
  { key: 'd5', kind: 'directional', label: '일주일', trading_days: 5 },
] as const;

export type HorizonKey = (typeof HORIZONS)[number]['key'];

/**
 * 병행 기록되는 규칙 후보. **현행(champion)을 바꾸지 않고** 옆에 하나 더 달아 같은 날
 * 같은 조건으로 채점받게 한다. 인샘플 숫자로 규칙을 갈아치우면 과거에 맞춰 깎는 셈이라,
 * 실전 표본이 쌓인 뒤에 고르려는 것이다.
 *
 * `trend_windows`가 null이면 현행 국면 판정(20/60)을 그대로 쓴다. 5거래일 지평은 두
 * 후보가 같은 창이라 후보를 따로 기록하지 않는다 — 같은 예측을 두 번 남길 이유가 없다.
 */
export const SIGNAL_VARIANTS = [
  {
    key: 'champion',
    label: '현행 20/60',
    trend_windows: null,
    rules: {} as SignalRules,
    horizons: ['d1', 'd5'] as HorizonKey[],
  },
  {
    key: 'ma_10_20',
    label: '지평별 창 10/20',
    trend_windows: { short: 10, long: 20 },
    rules: {} as SignalRules,
    // 5거래일에는 안 붙인다 — 이 후보는 추세 창만 바꾸는데 d5는 champion과 창이 같다.
    horizons: ['d1'] as HorizonKey[],
  },
  {
    key: 'split_trend',
    label: '추세 분리(위치·배열)',
    trend_windows: null,
    rules: { splitTrend: true } as SignalRules,
    horizons: ['d1', 'd5'] as HorizonKey[],
  },
  {
    key: 'inst_flow',
    label: '기관 수급 추가',
    trend_windows: null,
    rules: { institutionFlow: true } as SignalRules,
    horizons: ['d1', 'd5'] as HorizonKey[],
  },
] as const;

export type VariantKey = (typeof SIGNAL_VARIANTS)[number]['key'];

/**
 * 후보는 **하나씩만** 바꾼다. `split_trend`와 `inst_flow`를 한 후보에 합치면 둘 중
 * 무엇이 효과를 냈는지 영영 못 가른다. 둘 다 이기면 그때 합친 후보를 새로 단다.
 */
export function variantsFor(horizon: HorizonKey) {
  return SIGNAL_VARIANTS.filter((v) => (v.horizons as readonly HorizonKey[]).includes(horizon));
}

// ── 점수 시계열 + 백테스트 ──────────────────────────────────────────────

export interface SignalSeriesPoint {
  date: string;
  score: number;
  signal: SignalValue;
  gated: boolean;
  /** 원시 방향 — 게이트에 막힌 날도 방향은 있다 (게이트 검증용) */
  raw_direction: 'buy' | 'sell' | null;
  /** 판정 시점 국면. "어떤 장에서 무엇이 먹히나"를 되묻는 슬라이스 축이다. */
  regime: { trend: string; volatility: string; flow: string };
  /** 컴포넌트별 값 — 국면별로 어느 컴포넌트가 기여했는지 분해할 때 쓴다 */
  components: Record<string, number>;
}

/**
 * 규칙이 **한쪽만 부르고 있지 않은가**. 적중률이 못 하는 말을 한다.
 *
 * 왜 필요한가: `directional_1d`는 2026-08-04~08-25 24건이 전부 하방이었는데, 적중률
 * 지표만 봐서는 그게 안 보였다. 35%라는 숫자는 "가끔 틀린 규칙"처럼 읽히지만 실제로는
 * **상방 칸이 한 번도 안 켜진 상수**였다. 그 3주 동안 주가는 +21.7% 올랐다.
 *
 * 그래서 후보를 고를 때 적중률과 **같이** 본다. 한쪽만 부르는 규칙은 적중률이 좋아도
 * (기저율이 한쪽으로 쏠린 구간에서는 그럴 수 있다) 채택 후보가 아니다.
 */
export interface CallBalance {
  /** 방향을 낸 날 수 */
  n: number;
  up: number;
  down: number;
  /** 상방 비율. 0이나 1이면 규칙이 한쪽에 갇혀 있다. 방향을 낸 날이 없으면 null. */
  up_share: number | null;
  /** 컴포넌트별로 +1 / 0 / -1이 몇 번 나왔나 — 어느 재료가 갇혀 있는지 짚어준다. */
  components: Record<string, { pos: number; zero: number; neg: number }>;
}

export interface SignalBacktest {
  horizon_days: number;
  buy: { n: number; hits: number; hit_rate: number | null };
  sell: { n: number; hits: number; hit_rate: number | null };
  /**
   * 기저율: 같은 구간에서 **아무 날이나** 잡아도 그 지평 뒤 종가가 올랐을 확률.
   * 적중률은 이것과의 차이로만 의미가 있다 — 상승장에서는 무작위 매수도 60%가 나온다.
   */
  baseline_up_rate: number | null;
  /** 게이트를 통과한 신호의 방향 균형 */
  balance: CallBalance;
  /** 게이트를 무시한 원시 방향의 균형 — 쏠림이 게이트 탓인지 재료 탓인지 가른다 */
  raw_balance: CallBalance;
  note: string;
}

/** 시계열에서 방향 균형을 센다. `pick`이 그 날의 방향을 준다(null이면 방향 없음). */
export function computeCallBalance(
  series: SignalSeriesPoint[],
  pick: (pt: SignalSeriesPoint) => 'buy' | 'sell' | null,
): CallBalance {
  let up = 0;
  let down = 0;
  const components: CallBalance['components'] = {};
  for (const pt of series) {
    for (const [k, v] of Object.entries(pt.components)) {
      components[k] = components[k] ?? { pos: 0, zero: 0, neg: 0 };
      if (v > 0) components[k]!.pos++;
      else if (v < 0) components[k]!.neg++;
      else components[k]!.zero++;
    }
    const d = pick(pt);
    if (d === 'buy') up++;
    else if (d === 'sell') down++;
  }
  const n = up + down;
  return { n, up, down, up_share: n > 0 ? Number((up / n).toFixed(3)) : null, components };
}

/**
 * 규칙 점수를 과거 각 거래일에 재적용한 시계열 + 기본 지평 백테스트.
 * 여러 지평이 필요하면 반환된 series로 `computeSignalBacktest`를 다시 부르면 된다
 * (시계열 재계산은 O(n²)라 비싸다 — 한 번 만들고 재사용할 것).
 *
 * **룩어헤드 방지가 이 함수의 존재 이유다**: i일의 점수는 i일까지의 일봉·수급·벤치마크만
 * 잘라서 계산한다. 백테스트 조건은 recordStockSignal과 동일 — 신호일 종가 대비
 * N거래일 뒤 종가의 방향.
 *
 * 한계(표시 문구에 반드시 포함): ① 인샘플 — 임계값을 이 데이터를 보며 정했다.
 * ② 수급 이력이 30거래일뿐이라 그 이전 구간은 수급 컴포넌트가 0이다.
 */
/** 시계열에 대해 특정 지평의 백테스트를 낸다 — recordStockSignal과 같은 채점 조건. */
export function computeSignalBacktest(
  series: SignalSeriesPoint[],
  bars: Bar[],
  horizon: number,
): SignalBacktest {
  const closes = bars.map((b) => b.close);
  const indexByDate = new Map(bars.map((b, idx) => [b.date, idx]));
  const buy = { n: 0, hits: 0, hit_rate: null as number | null };
  const sell = { n: 0, hits: 0, hit_rate: null as number | null };
  let baseN = 0;
  let baseUp = 0;
  for (const pt of series) {
    const idx = indexByDate.get(pt.date)!;
    if (idx + horizon >= closes.length) continue;
    baseN++;
    if (closes[idx + horizon]! > closes[idx]!) baseUp++;
    if (pt.signal === 'watch') continue;
    const entry = closes[idx]!;
    const exit = closes[idx + horizon]!;
    const bucket = pt.signal === 'buy' ? buy : sell;
    bucket.n++;
    if ((pt.signal === 'buy' && exit > entry) || (pt.signal === 'sell' && exit < entry)) bucket.hits++;
  }
  buy.hit_rate = buy.n > 0 ? Number((buy.hits / buy.n).toFixed(3)) : null;
  sell.hit_rate = sell.n > 0 ? Number((sell.hits / sell.n).toFixed(3)) : null;
  return {
    horizon_days: horizon,
    buy,
    sell,
    baseline_up_rate: baseN > 0 ? Number((baseUp / baseN).toFixed(3)) : null,
    balance: computeCallBalance(series, (pt) => (pt.signal === 'watch' ? null : pt.signal)),
    raw_balance: computeCallBalance(series, (pt) => pt.raw_direction),
    note: '규칙을 만들 때 이미 본 과거 데이터로 채점한 값이라, 실제 성적보다 좋게 나온다.',
  };
}

export function computeSignalSeries(
  bars: Bar[],
  flows: Flow[],
  benchmarks: BenchmarkSeries[],
  opts: { minWindow?: number; horizon?: number } = {},
): { series: SignalSeriesPoint[]; backtest: SignalBacktest } {
  const minWindow = opts.minWindow ?? 80;
  const horizon = opts.horizon ?? 5;
  const series: SignalSeriesPoint[] = [];
  const sortedFlows = [...flows].sort((a, b) => a.date.localeCompare(b.date));

  for (let i = minWindow; i < bars.length; i++) {
    const date = bars[i]!.date;
    const upto = bars.slice(0, i + 1);
    const flowsUpto = sortedFlows.filter((f) => f.date <= date);
    const benchUpto = benchmarks.map((b) => ({
      ...b,
      bars: b.bars.filter((x) => x.date <= date),
    }));
    const ind = computeIndicators(upto, flowsUpto, benchUpto);
    const regime = classifyRegime(ind);
    const sig = computeSignal(ind, regime);
    if (sig && regime) {
      series.push({
        date,
        score: sig.score,
        signal: sig.signal,
        gated: sig.gated_by_volatility,
        raw_direction: sig.raw_direction,
        regime: { trend: regime.trend, volatility: regime.volatility, flow: regime.flow },
        components: Object.fromEntries(sig.components.map((c) => [c.key, c.value])),
      });
    }
  }

  return { series, backtest: computeSignalBacktest(series, bars, horizon) };
}

// ── 국면별 성능 분해 ────────────────────────────────────────────────────

export interface RegimeSlice {
  /** 슬라이스 축과 값. 예: { axis: 'volatility', value: 'extreme' } */
  axis: string;
  value: string;
  n: number;
  hits: number;
  hit_rate: number | null;
  baseline_up_rate: number | null;
  /** 기저율 대비 초과 (%p) — 이 국면에서 규칙이 실제로 보탠 몫 */
  edge_pp: number | null;
}

export interface ComponentSlice {
  component: string;
  /** 이 컴포넌트가 켜진(±1) 날만 모아 그 방향의 적중률 */
  n: number;
  hits: number;
  hit_rate: number | null;
  baseline_up_rate: number | null;
  edge_pp: number | null;
}

const pct = (a: number, b: number): number | null => (b > 0 ? Number((a / b).toFixed(3)) : null);
const ppDiff = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Number(((a - b) * 100).toFixed(1));

/**
 * "어떤 장에서 어떤 규칙이 먹히나"를 되묻는 분해.
 *
 * 국면별(추세/변동성/수급)로 원시 방향의 적중률과 **그 국면의 기저율**을 나란히 낸다.
 * 국면마다 기저율이 다르다는 게 핵심이다 — 상승 추세 구간에서는 아무 날이나 사도
 * 잘 맞으므로, 국면별 기저율을 빼지 않으면 "상승장에서 규칙이 잘 맞는다"는 동어반복만
 * 나온다.
 *
 * 여기 나오는 수치는 **게이트를 무시한 원시 방향** 기준이다. 게이트에 막힌 날도
 * 포함해야 게이트가 옳았는지 판정할 수 있기 때문이다.
 */
export function computeRegimeBreakdown(
  series: SignalSeriesPoint[],
  bars: Bar[],
  horizon: number,
): { regimes: RegimeSlice[]; components: ComponentSlice[] } {
  const closes = bars.map((b) => b.close);
  const idx = new Map(bars.map((b, i) => [b.date, i]));

  type Acc = { n: number; hits: number; baseN: number; baseUp: number };
  const mk = (): Acc => ({ n: 0, hits: 0, baseN: 0, baseUp: 0 });
  const regimeAcc = new Map<string, Acc>();
  const compAcc = new Map<string, Acc>();

  for (const pt of series) {
    const i = idx.get(pt.date);
    if (i === undefined || i + horizon >= closes.length) continue;
    const up = closes[i + horizon]! > closes[i]!;

    for (const [axis, value] of Object.entries(pt.regime)) {
      const key = `${axis}|${value}`;
      const a = regimeAcc.get(key) ?? mk();
      a.baseN++;
      if (up) a.baseUp++;
      if (pt.raw_direction) {
        a.n++;
        if (pt.raw_direction === 'buy' ? up : !up) a.hits++;
      }
      regimeAcc.set(key, a);
    }

    for (const [comp, v] of Object.entries(pt.components)) {
      if (v === 0) continue; // 꺼진 컴포넌트는 이 슬라이스에 기여하지 않는다
      const a = compAcc.get(comp) ?? mk();
      a.baseN++;
      if (up) a.baseUp++;
      a.n++;
      if (v > 0 ? up : !up) a.hits++;
      compAcc.set(comp, a);
    }
  }

  const regimes: RegimeSlice[] = [...regimeAcc.entries()]
    .map(([key, a]) => {
      const [axis, value] = key.split('|') as [string, string];
      const hit = pct(a.hits, a.n);
      const base = pct(a.baseUp, a.baseN);
      return { axis, value, n: a.n, hits: a.hits, hit_rate: hit, baseline_up_rate: base, edge_pp: ppDiff(hit, base) };
    })
    .sort((x, y) => x.axis.localeCompare(y.axis) || y.n - x.n);

  const components: ComponentSlice[] = [...compAcc.entries()]
    .map(([component, a]) => {
      const hit = pct(a.hits, a.n);
      const base = pct(a.baseUp, a.baseN);
      return { component, n: a.n, hits: a.hits, hit_rate: hit, baseline_up_rate: base, edge_pp: ppDiff(hit, base) };
    })
    .sort((x, y) => (y.edge_pp ?? -99) - (x.edge_pp ?? -99));

  return { regimes, components };
}
