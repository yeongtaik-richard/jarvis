/**
 * 장중 읽기 — "지금부터 오늘 남은 시간은 어떨 것 같은가" 한 줄.
 *
 * 일별 규칙 신호와 다른 물건이다:
 * - 일별 신호: 확정 봉으로 계산, 하루/일주일 **뒤**를 본다. 기록되고 채점된다.
 * - 장중 읽기: 오늘 진행 중인 데이터로 계산, **오늘 남은 시간**을 본다. 채점하지 않는다.
 *
 * 핵심 질문은 하나다 — **가격이 움직인 방향을 받쳐주는 것이 있는가.**
 * 올랐는데 수급도 사는 쪽이고 고가권을 지키면 "받쳐진다". 올랐는데 수급이 팔고 저가권으로
 * 밀렸으면 "받쳐주는 게 없다"이고, 그건 되돌릴 수 있다는 뜻이다. 리처드가 말한
 * "이유 없이 올랐고 외국인·기관이 팔고 있어 남은 시간 하락할 수 있다"가 이 판정이다.
 *
 * **뉴스 호재/악재는 여기서 판정하지 않는다.** 규칙이 할 수 있는 일이 아니고, 정직성
 * 규칙이 금지하는 것이기도 하다. 뉴스 맥락은 아래 브리핑(§6b 오늘 읽기)이 산문으로 다룬다.
 *
 * **채점하지 않는다.** 채점은 일별 규칙 예측(하루·일주일)이 한다. 여기에 레인을 하나 더
 * 만들면 표본이 늘기 전에 축만 늘어난다.
 */

export interface IntradayBucket {
  /** 'YYYY-MM-DDTHH:00+09:00' */
  bucketKey: string;
  price: number;
  changeRate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  programNetQty: number | null;
  /** KIS frgn_ntby_qty — 보유수량 일별 변화다. 장중 수급이 아니라 근거로 쓰지 않는다. */
  foreignHoldingDeltaQty: number | null;
}

export interface ReadFactor {
  key: 'day_position' | 'momentum' | 'program' | 'prev_flow';
  /** 가격을 위로 받치면 +1, 아래로 끄면 -1, 판단 못 하면 0 */
  value: -1 | 0 | 1;
  text: string;
}

export type ReadLean = 'supported' | 'fading' | 'recovering' | 'weak' | 'unclear';

export interface IntradayRead {
  lean: ReadLean;
  /** 한 줄. 이게 이 모듈의 산출물이다. */
  headline: string;
  factors: ReadFactor[];
  /** 신뢰를 깎는 것들. 비어 있으면 없는 것이다. */
  caveats: string[];
  /** 마지막 관측 시각 (KST HH:MM) */
  at: string;
}

/** 일중 고저 범위에서 이 비율 위/아래면 위치가 방향을 가리킨다고 본다. */
const POS_HIGH = 0.6;
const POS_LOW = 0.4;
/** 직전 시간 대비 이 %를 넘어야 모멘텀으로 친다 (그 아래는 잡음). */
const MOMENTUM_PCT = 0.3;
/** 프로그램 순매수 변화가 이 주식 수를 넘어야 방향으로 친다. */
const PROGRAM_QTY = 10_000;

const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const qty = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}주`;
/** 수급 대금은 백만원 단위로 온다. */
const tril = (v: number) => `${(Math.abs(v) / 1_000_000).toFixed(2)}조`;

/**
 * 여러 버킷에서 값이 한 번도 안 변했으면 갱신되지 않는 필드로 본다.
 * 실시간 누적치가 몇 시간째 같을 수는 없다. 이런 값을 근거에 넣으면 없는 신호를
 * 지어내는 셈이다. (KIS의 외국인 필드가 굳어 보였던 건 이 경우가 아니라 애초에
 * 장중 값이 아니어서였다 — kis-marketdata.ts `foreignHoldingDeltaQty` 참고.)
 */
function isFrozen(values: Array<number | null>): boolean {
  const seen = values.filter((v): v is number => v !== null);
  return seen.length >= 3 && new Set(seen).size === 1;
}

export function computeIntradayRead(
  buckets: IntradayBucket[],
  /** 전일 확정 수급 (백만원). 외국인 + 기관 합. null이면 이 재료를 뺀다. */
  prevFlowSum: number | null,
): IntradayRead | null {
  const last = buckets[buckets.length - 1];
  if (!last || !Number.isFinite(last.price)) return null;
  const prev = buckets[buckets.length - 2];
  const factors: ReadFactor[] = [];
  const caveats: string[] = [];

  // 1) 일중 위치 — 고가권을 지키는지 저가권으로 밀렸는지
  const hi = last.high;
  const lo = last.low;
  if (hi !== null && lo !== null && hi > lo) {
    const pos = (last.price - lo) / (hi - lo);
    factors.push({
      key: 'day_position',
      value: pos > POS_HIGH ? 1 : pos < POS_LOW ? -1 : 0,
      text: `오늘 범위의 ${Math.round(pos * 100)}% 지점 (저 ${lo.toLocaleString('ko-KR')} / 고 ${hi.toLocaleString('ko-KR')})`,
    });
    if ((hi - lo) / lo > 0.05) {
      caveats.push(`일중 변동폭 ${(((hi - lo) / lo) * 100).toFixed(1)}%로 방향이 자주 뒤집힌다`);
    }
  }

  // 2) 직전 시간 모멘텀
  if (prev && Number.isFinite(prev.price) && prev.price > 0) {
    const mom = ((last.price - prev.price) / prev.price) * 100;
    factors.push({
      key: 'momentum',
      value: mom > MOMENTUM_PCT ? 1 : mom < -MOMENTUM_PCT ? -1 : 0,
      text: `직전 시간 대비 ${pct(mom)}`,
    });
  } else {
    caveats.push('비교할 직전 시간 데이터가 없다');
  }

  // 3) 프로그램 수급 — 절대 수준이 아니라 **직전 대비 증감**이 의미 있다.
  //    누적 순매도여도 줄어들고 있으면 매도 압력이 빠지는 중이다.
  const progFrozen = isFrozen(buckets.map((b) => b.programNetQty));
  if (!progFrozen && prev && last.programNetQty !== null && prev.programNetQty !== null) {
    const d = last.programNetQty - prev.programNetQty;
    factors.push({
      key: 'program',
      value: d > PROGRAM_QTY ? 1 : d < -PROGRAM_QTY ? -1 : 0,
      text: `프로그램 순매수 직전 대비 ${qty(d)}`,
    });
  } else if (progFrozen) {
    caveats.push('프로그램 수급 값이 갱신되지 않아 근거에서 뺐다');
  }
  // KIS의 외국인 필드는 장중 수급이 아니라 보유수량 일별 변화라 애초에 재료가 아니다.
  // 아래 '어제 확정 수급'이 외국인 방향을 대신 담당한다.

  // 4) 전일 확정 수급 — 오늘 장중 수급은 못 믿을 때가 있어서, 확정된 어제 방향을 같이 본다
  if (prevFlowSum !== null && Number.isFinite(prevFlowSum)) {
    factors.push({
      key: 'prev_flow',
      value: prevFlowSum > 0 ? 1 : prevFlowSum < 0 ? -1 : 0,
      text: `어제 외국인·기관 합계 ${prevFlowSum >= 0 ? '순매수' : '순매도'} ${tril(prevFlowSum)}`,
    });
  }

  const support = factors.reduce((a, f) => a + f.value, 0);
  const chg = last.changeRate ?? 0;
  const up = chg > 0.3;
  const down = chg < -0.3;

  let lean: ReadLean;
  let headline: string;
  if (factors.length < 2) {
    lean = 'unclear';
    headline = '남은 시간을 가늠할 재료가 아직 부족하다';
  } else if (up && support > 0) {
    lean = 'supported';
    headline = '오른 흐름을 수급과 위치가 받치고 있다 — 남은 시간도 이 근처를 지킬 만하다';
  } else if (up && support < 0) {
    lean = 'fading';
    headline = '가격은 올랐는데 받쳐주는 게 안 보인다 — 남은 시간 되돌릴 수 있다';
  } else if (down && support < 0) {
    lean = 'weak';
    headline = '내리는 흐름과 수급이 같은 방향이다 — 남은 시간도 약할 수 있다';
  } else if (down && support > 0) {
    lean = 'recovering';
    headline = '내렸지만 사는 쪽 재료가 있다 — 남은 시간 낙폭을 줄일 수 있다';
  } else {
    lean = 'unclear';
    headline = up
      ? '올랐지만 방향을 정할 재료가 엇갈린다'
      : down
        ? '내렸지만 방향을 정할 재료가 엇갈린다'
        : '전일 종가 근처에서 방향을 정하지 못하고 있다';
  }

  return {
    lean,
    headline,
    factors,
    caveats,
    at: last.bucketKey.slice(11, 16),
  };
}
