/**
 * 프리마켓 신호 — 개장 전에 **간밤 해외 시장**으로 오늘을 예측한다.
 *
 * 왜 별도 레인인가: 같은 재료라도 **언제 예측하느냐**가 값어치를 가른다. 전날 18:43에
 * 익일 종가를 예측하면 그 시점에 있는 SOX는 이틀 전 것이고 이미 어제 주가에 반영돼
 * 있다 — 인샘플 −4.1%p. 같은 SOX를 개장 전(간밤 마감 뒤)에 쓰면 +12.6%p가 된다.
 * 재료를 바꾼 게 아니라 시점을 옮긴 것이다.
 *
 * ## 컴포넌트 (2026-08-05 인샘플 측정, 프리마켓 시점에 실제 쓸 수 있는 값만)
 * | 재료 | n | 당일 시가 | 당일 종가 |
 * |---|---|---|---|
 * | 간밤 SOX | 169 | +28.7%p | +12.6%p |
 * | 간밤 나스닥 | 90 | +33.9%p | +16.1%p |
 * | 간밤 원/달러(역) | 156 | +14.2%p | +6.7%p |
 *
 * 뺀 것: **ADR**은 표본 13건뿐이라 못 쓴다(가장 직접적인 재료일 텐데 수집 이력이 짧다 —
 * 쌓이면 넣는다). **전일 삼성전자**는 +0.7%p / −7.3%p로 효과가 없다. 이미 어제 한국장에서
 * 같이 움직인 정보라 새로울 게 없다는 뜻으로 읽힌다.
 *
 * ## 시가 예측을 액면대로 믿으면 안 된다
 * 시가 쪽 수치가 큰 건 **거의 동어반복**이기 때문이다 — 갭이 곧 간밤 해외장을 반영하는
 * 것이라 "미국이 올랐으니 갭업한다"는 예측이라기보다 정의에 가깝다. 그래도 "오늘 갭업으로
 * 출발한다"는 알고 싶은 정보라 남긴다. 진짜 값어치는 **종가** 쪽에 있다.
 */

export interface OvernightInput {
  /** 간밤 변화율 (%). 없으면 null. */
  soxPct: number | null;
  nasdaqPct: number | null;
  /** 원/달러 변화율 (%). 원화 강세면 음수. */
  usdkrwPct: number | null;
}

export interface PremarketComponent {
  key: 'sox' | 'nasdaq' | 'usdkrw';
  value: -1 | 0 | 1;
  reason: string;
}

export interface PremarketSignal {
  direction: 'up' | 'down' | null;
  score: number;
  maxScore: number;
  components: PremarketComponent[];
  headline: string;
}

/** 해외 지수는 이 %를 넘어야 방향으로 친다. */
const INDEX_PCT = 1;
/** 환율은 움직임 폭이 작아 임계도 낮다. */
const FX_PCT = 0.3;
/** |score|가 이 값 이상이어야 방향을 낸다. */
const THRESHOLD = 2;

const sign = (v: number, th: number): -1 | 0 | 1 => (v > th ? 1 : v < -th ? -1 : 0);
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export function computePremarketSignal(input: OvernightInput): PremarketSignal | null {
  const components: PremarketComponent[] = [];

  if (input.soxPct !== null) {
    components.push({
      key: 'sox',
      value: sign(input.soxPct, INDEX_PCT),
      reason: `간밤 미국 반도체(SOX) ${pct(input.soxPct)}`,
    });
  }
  if (input.nasdaqPct !== null) {
    components.push({
      key: 'nasdaq',
      value: sign(input.nasdaqPct, INDEX_PCT),
      reason: `간밤 나스닥 ${pct(input.nasdaqPct)}`,
    });
  }
  if (input.usdkrwPct !== null) {
    // 원화가 강해지면(환율 하락) 외국인 자금에 유리 — 부호를 뒤집는다.
    components.push({
      key: 'usdkrw',
      value: sign(-input.usdkrwPct, FX_PCT),
      reason: `간밤 원/달러 ${pct(input.usdkrwPct)} (${input.usdkrwPct < 0 ? '원화 강세' : '원화 약세'})`,
    });
  }
  // 재료가 둘 미만이면 임계(2)를 넘을 수 없어 판정 자체가 성립하지 않는다.
  if (components.length < 2) return null;

  const score = components.reduce((a, c) => a + c.value, 0);
  const direction = score >= THRESHOLD ? 'up' : score <= -THRESHOLD ? 'down' : null;
  const lit = components.filter((c) => c.value !== 0);
  const headline =
    direction === null
      ? `간밤 해외장이 방향을 정하지 못했다 (점수 ${score >= 0 ? '+' : ''}${score})`
      : `간밤 해외장이 ${direction === 'up' ? '상방' : '하방'}을 가리킨다 — ${lit.map((c) => c.reason).join(' · ')}`;

  return { direction, score, maxScore: components.length, components, headline };
}
