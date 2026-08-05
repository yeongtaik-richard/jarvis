/**
 * 채점 회고 — "왜 맞았나, 왜 틀렸나, 무엇을 놓쳤나."
 *
 * 예측을 기록할 때 `context`에 **그날 각 컴포넌트가 뭐라 했는지와 국면을 박제**해뒀다
 * (stock-signal-service.ts). 그래서 채점된 뒤에 되돌아보면 자동으로 답이 나온다:
 * - 어떤 컴포넌트가 맞는 쪽을 가리켰고 어떤 게 틀린 쪽을 가리켰나
 * - 그게 어떤 국면에서였나
 * - **우리가 안 보는 것 중에 그 구간에 크게 움직인 게 있나** ← 놓친 재료 후보
 *
 * 마지막 항목이 이 파일의 핵심이다. 컴포넌트 3개가 다 틀렸는데 그 사이 시장이 4% 올랐다면,
 * 문제는 임계값이 아니라 **시장 컴포넌트가 없다는 것**이다. 그건 기존 컴포넌트를 아무리
 * 들여다봐도 안 나온다.
 *
 * 여기서 규칙을 자동으로 바꾸지는 않는다. 회고는 후보를 제시하고, 바꾸는 건 표본이
 * 쌓인 뒤 사람이 한다 — 한 건 틀렸다고 규칙을 고치면 그게 과최적화의 시작이다.
 */

import type { LedgerEntry } from './prediction-ledger';

export interface ComponentVerdict {
  key: string;
  label: string;
  /** 예측 당시 이 컴포넌트가 가리킨 방향 */
  said: 'up' | 'down' | 'neutral';
  /** 실제 결과와 같은 방향이었나. neutral이면 null. */
  correct: boolean | null;
}

export interface MissedCandidate {
  key: string;
  label: string;
  /** 예측 구간 동안의 변화율 (%) */
  changePct: number;
  /** 왜 후보인지 */
  reason: string;
}

export interface PredictionReview {
  id: string;
  hit: boolean;
  /** 한 줄 회고 */
  headline: string;
  components: ComponentVerdict[];
  /** 우리가 컴포넌트로 안 쓰는 것 중 그 구간에 크게 움직인 것 */
  missed: MissedCandidate[];
  volatility: string | null;
}

const COMPONENT_LABEL: Record<string, string> = {
  trend: '추세',
  flow: '외국인 수급',
  relative_sox: '미국 반도체 대비',
};

/** 이 %를 넘게 움직였으면 "놓친 재료" 후보로 올린다. */
const MISSED_THRESHOLD_PCT = 3;

export interface WindowMove {
  key: string;
  label: string;
  changePct: number;
}

/**
 * @param entry  채점이 끝난 장부 항목
 * @param moves  예측 구간(as_of → target) 동안 **컴포넌트로 안 쓰는** 지표들의 변화율
 */
export function reviewPrediction(
  entry: LedgerEntry,
  moves: WindowMove[],
): PredictionReview | null {
  if (entry.status !== 'confirmed' && entry.status !== 'refuted') return null;
  const hit = entry.status === 'confirmed';
  // 실제로 간 방향. change_pct는 기준 대비 대상일 종가의 변화다.
  const actualUp = (entry.change_pct ?? 0) > 0;

  const components: ComponentVerdict[] = Object.entries(entry.components).map(([key, v]) => ({
    key,
    label: COMPONENT_LABEL[key] ?? key,
    said: v > 0 ? 'up' : v < 0 ? 'down' : 'neutral',
    correct: v === 0 ? null : v > 0 === actualUp,
  }));

  const right = components.filter((c) => c.correct === true);
  const wrong = components.filter((c) => c.correct === false);
  const idle = components.filter((c) => c.correct === null);

  // 놓친 재료 — 컴포넌트가 대부분 틀렸을 때만 의미가 있다. 맞았는데 시장이 움직인 건
  // 굳이 후보로 올릴 이유가 없다(맞은 이유가 시장일 수도 있지만 그건 다른 분석이다).
  const missed: MissedCandidate[] =
    hit || wrong.length === 0
      ? []
      : moves
          .filter((m) => Math.abs(m.changePct) >= MISSED_THRESHOLD_PCT)
          .map((m) => ({
            key: m.key,
            label: m.label,
            changePct: m.changePct,
            reason: `${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(1)}% 움직였는데 신호에 안 들어간다`,
          }))
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
          .slice(0, 3);

  const parts: string[] = [];
  if (hit) {
    parts.push(
      right.length > 0
        ? `${right.map((c) => c.label).join('·')}가 맞는 쪽을 가리켰다`
        : '컴포넌트는 방향을 못 짚었는데 결과가 맞았다',
    );
    if (wrong.length > 0) parts.push(`${wrong.map((c) => c.label).join('·')}는 반대였다`);
  } else {
    parts.push(
      wrong.length > 0
        ? `${wrong.map((c) => c.label).join('·')}가 반대 방향을 가리켰다`
        : '방향을 가리킨 컴포넌트가 없었다',
    );
    if (right.length > 0) parts.push(`${right.map((c) => c.label).join('·')}만 맞았다`);
  }
  if (idle.length > 0) parts.push(`${idle.map((c) => c.label).join('·')}는 중립이라 기여 없음`);
  if (missed.length > 0) {
    parts.push(`같은 기간 ${missed[0]!.label} ${missed[0]!.changePct >= 0 ? '+' : ''}${missed[0]!.changePct.toFixed(1)}%`);
  }

  return {
    id: entry.id,
    hit,
    headline: parts.join(' · '),
    components,
    missed,
    volatility: entry.volatility,
  };
}

// ── 누적 귀속 — "어떤 상황에 어떤 지표가 크게 작용하나" ──────────────────

export interface ComponentAttribution {
  key: string;
  label: string;
  /** 이 컴포넌트가 방향을 가리킨 채점 건수 */
  fired: number;
  /** 그중 맞은 수 */
  correct: number;
  hitRate: number | null;
  /** 같은 표본에서 그냥 오른 비율 — 이걸 넘어야 기여했다고 말할 수 있다 */
  baselineUpRate: number | null;
  edgePp: number | null;
}

export interface AttributionSlice {
  /** 'all' 또는 국면 값 (예: 'extreme') */
  scope: string;
  label: string;
  samples: number;
  components: ComponentAttribution[];
}

/**
 * 채점된 예측들로 **실전** 컴포넌트 기여도를 낸다.
 *
 * 인샘플 분해(`computeRegimeBreakdown`)와 뭐가 다른가: 저건 과거에 규칙을 재적용해서
 * 잰 것이고, 이건 **실제로 기록된 뒤 채점된 것**만 센다. 규칙을 만들 때 이미 본 데이터가
 * 아니라서, 표본이 쌓이면 이쪽이 유일하게 믿을 숫자가 된다.
 *
 * 국면별로 쪼개는 이유는 리처드가 말한 그것이다 — 어떤 장에서 어떤 지표가 크게 작용하고
 * 어떤 장에서 작게 작용하는지는 전체 평균으로는 안 보인다.
 */
export function computeAttribution(entries: LedgerEntry[]): AttributionSlice[] {
  const scored = entries.filter((e) => e.status === 'confirmed' || e.status === 'refuted');
  if (scored.length === 0) return [];

  const build = (subset: LedgerEntry[], scope: string, label: string): AttributionSlice => {
    const byKey = new Map<string, { fired: number; correct: number }>();
    let up = 0;
    for (const e of subset) {
      const actualUp = (e.change_pct ?? 0) > 0;
      if (actualUp) up++;
      for (const [k, v] of Object.entries(e.components)) {
        if (v === 0) continue;
        const a = byKey.get(k) ?? { fired: 0, correct: 0 };
        a.fired++;
        if (v > 0 === actualUp) a.correct++;
        byKey.set(k, a);
      }
    }
    const base = subset.length > 0 ? up / subset.length : null;
    return {
      scope,
      label,
      samples: subset.length,
      components: [...byKey.entries()]
        .map(([key, a]) => {
          const hr = a.fired > 0 ? a.correct / a.fired : null;
          return {
            key,
            label: COMPONENT_LABEL[key] ?? key,
            fired: a.fired,
            correct: a.correct,
            hitRate: hr,
            baselineUpRate: base,
            edgePp:
              hr !== null && base !== null ? Number(((hr - base) * 100).toFixed(1)) : null,
          };
        })
        .sort((x, y) => (y.edgePp ?? -99) - (x.edgePp ?? -99)),
    };
  };

  const slices: AttributionSlice[] = [build(scored, 'all', '전체')];
  const vols = [...new Set(scored.map((e) => e.volatility).filter(Boolean))] as string[];
  const VOL_LABEL: Record<string, string> = {
    calm: '변동성 낮음',
    normal: '변동성 보통',
    elevated: '변동성 높음',
    extreme: '변동성 극단',
  };
  for (const v of vols) {
    const subset = scored.filter((e) => e.volatility === v);
    // 표본 3건 미만은 숫자가 아니라 잡음이다
    if (subset.length >= 3) slices.push(build(subset, v, VOL_LABEL[v] ?? v));
  }
  return slices;
}
