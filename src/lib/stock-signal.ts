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

import type { Indicators, Regime } from './stock-indicators';

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
