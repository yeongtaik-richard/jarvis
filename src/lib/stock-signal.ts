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
} from './stock-indicators';

export type SignalValue = 'buy' | 'sell' | 'watch';

export interface SignalComponent {
  key: 'trend' | 'flow' | 'relative_sox';
  value: -1 | 0 | 1;
  reason: string;
}

export interface RuleSignal {
  signal: SignalValue;
  /** 컴포넌트 합. [-3, +3] */
  score: number;
  max_score: number;
  components: SignalComponent[];
  /** 변동성 극단 구간에서 임계 미달로 watch로 강등됐는가 */
  gated_by_volatility: boolean;
  disclaimer: string;
}

/** |score|가 이 값 이상이어야 방향 신호. */
const SIGNAL_THRESHOLD = 2;
/** 변동성 극단(≥90%ile)에서는 만점일 때만 방향 신호 — 급등락 구간의 신호는 신뢰도가 낮다. */
const EXTREME_VOL_THRESHOLD = 3;
/** SOX 대비 20일 초과수익이 이 %p를 넘어야 상대강도 컴포넌트가 켜진다. */
const RS_EXCESS_PCT = 5;

export const SIGNAL_DISCLAIMER =
  '규칙 기반 미검증 신호다. 매매 지시가 아니며, directional 적중률 표본과 함께만 읽을 것.';

export function computeSignal(
  ind: Indicators | null,
  regime: Regime | null,
): RuleSignal | null {
  if (!ind || !regime) return null;

  const components: SignalComponent[] = [];

  // 1) 추세 — regime의 보수적 판정을 그대로 쓴다 (가격·MA 배열이 일치할 때만 방향).
  components.push({
    key: 'trend',
    value: regime.trend === 'up' ? 1 : regime.trend === 'down' ? -1 : 0,
    reason:
      regime.trend === 'unknown'
        ? '추세 판단 불가(표본 부족)'
        : `추세 ${regime.trend} (MA20 대비 ${ind.dist_ma20_pct ?? '?'}%)`,
  });

  // 2) 수급 — 외국인 20일 누적과 연속 방향이 일치할 때만 방향.
  components.push({
    key: 'flow',
    value: regime.flow === 'foreign_buying' ? 1 : regime.flow === 'foreign_selling' ? -1 : 0,
    reason:
      regime.flow === 'mixed'
        ? '수급 엇갈림(누적과 최근 방향 불일치)'
        : `외국인 ${regime.flow === 'foreign_buying' ? '순매수' : regime.flow === 'foreign_selling' ? '순매도' : '판단 불가'} 지속 (연속 ${Math.abs(ind.foreign_streak_days)}일)`,
  });

  // 3) 상대강도 — 종목이 안 들어간 벤치마크(SOX)만 쓴다. 오염 지수는 신호에 넣지 않는다.
  const sox = ind.relative.find((r) => r.key === 'sox' && !r.contains_stock);
  const rsExcess = sox?.excess_20d ?? null;
  components.push({
    key: 'relative_sox',
    value:
      rsExcess === null ? 0 : rsExcess > RS_EXCESS_PCT ? 1 : rsExcess < -RS_EXCESS_PCT ? -1 : 0,
    reason:
      rsExcess === null
        ? 'SOX 대비 초과수익 계산 불가'
        : `SOX 대비 20일 초과수익 ${rsExcess > 0 ? '+' : ''}${rsExcess}%p`,
  });

  const score = components.reduce((a, c) => a + c.value, 0);
  const extreme = regime.volatility === 'extreme';
  const threshold = extreme ? EXTREME_VOL_THRESHOLD : SIGNAL_THRESHOLD;

  let signal: SignalValue = 'watch';
  if (score >= threshold) signal = 'buy';
  else if (score <= -threshold) signal = 'sell';

  const gated =
    extreme && Math.abs(score) >= SIGNAL_THRESHOLD && Math.abs(score) < EXTREME_VOL_THRESHOLD;

  return {
    signal,
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
 */
export const HORIZONS = [
  { key: 'd1', kind: 'directional_1d', label: '하루', trading_days: 1, calendar_days: 1 },
  { key: 'd5', kind: 'directional', label: '일주일', trading_days: 5, calendar_days: 7 },
] as const;

export type HorizonKey = (typeof HORIZONS)[number]['key'];

// ── 점수 시계열 + 백테스트 ──────────────────────────────────────────────

export interface SignalSeriesPoint {
  date: string;
  score: number;
  signal: SignalValue;
  gated: boolean;
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
  note: string;
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
    note: '과거 데이터에 같은 규칙을 재적용한 인샘플 백테스트다. 실전 성적이 아니며, 수급 컴포넌트는 이력이 있는 최근 구간만 반영된다.',
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
    if (sig) {
      series.push({ date, score: sig.score, signal: sig.signal, gated: sig.gated_by_volatility });
    }
  }

  return { series, backtest: computeSignalBacktest(series, bars, horizon) };
}
