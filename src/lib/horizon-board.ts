/**
 * 지평 보드 — "10분 뒤부터 1년 뒤까지, 각 시점에 대해 우리가 무엇을 말할 수 있나."
 *
 * 이 파일의 존재 이유는 **말할 수 없는 것을 말할 수 없다고 적어두는 것**이다.
 * 11개 지평에 화살표를 다 채우면 그게 거짓말이다. 지평마다 재료가 있는지, 검증이
 * 가능한지가 다르고, 그 차이를 화면이 숨기면 안 된다.
 *
 * ## 검증 표본 수학이 모든 걸 결정한다
 * 지평 h거래일짜리 예측은 중첩 없는 표본이 **연 250/h개**뿐이다.
 * | 지평 | 거래일 | 30표본까지 |
 * |---|---|---|
 * | 익일 | 1 | 6주 |
 * | 다음 주 | 5 | 7개월 |
 * | 다음 달 | 20 | 2.4년 |
 * | 6달 | 120 | 14년 |
 * | 1년 | 250 | **30년** |
 *
 * 그래서 **긴 지평은 방향을 예측하지 않는다.** 검증에 30년 걸리는 화살표는 영원히
 * 미검증으로 남고, 미검증 화살표는 없느니만 못하다. 대신 **지금 확인 가능한 위치**를
 * 답한다 — "PBR이 이력의 하위 15%"는 예측이 아니라 사실이라 오늘 검증된다.
 * (한 종목만 추적하기 때문이다. 200종목이면 1년 지평도 연 200표본이 나온다.)
 *
 * ## 만들면서 나아지는 구조
 * 각 지평은 예측하고, 기록하고, 채점받는다. 표본이 쌓이면 어떤 재료가 어느 지평에서
 * 먹히는지 데이터로 답이 나오고, 그때 규칙을 고친다. 완벽한 예측이 목표가 아니라
 * **틀린 걸 틀렸다고 아는 구조**가 목표다 — 큰 신호를 놓치지 않게 되는 건 그 과정에서
 * 따라오는 것이지, 따로 겨냥해서 되는 게 아니다.
 */

export type HorizonStatus =
  /** 재료 자체가 없다 — 수집이 먼저다 */
  | 'no_data'
  /** 재료는 있는데 아직 안 만들었다 */
  | 'not_built'
  /** 예측하고 기록·채점 중 */
  | 'live'
  /** 방향은 안 낸다. 대신 지금 확인 가능한 위치를 보여준다 */
  | 'position_only';

export interface HorizonSpec {
  key: string;
  label: string;
  /** 대략 몇 거래일짜리 지평인가. 분 단위는 1보다 작다. */
  tradingDays: number;
  /** 이 지평을 예측하려면 무엇이 필요한가 (사람이 읽는 말) */
  needs: string;
  status: HorizonStatus;
  /** 예측 레인의 kind. status가 'live'일 때만 있다. */
  kind?: string;
  /** 왜 이 상태인지 — 화면에 그대로 나간다 */
  note: string;
}

/** 독립 표본 30개까지 몇 거래일 걸리나 (중첩 창은 실질 표본이 n/h이라는 전제). */
export function tradingDaysTo30Samples(tradingDays: number): number {
  return Math.ceil(Math.max(tradingDays, 1) * 30);
}

/** 사람이 읽는 기간. 250거래일 = 1년. */
export function humanSpan(tradingDays: number): string {
  if (tradingDays < 1) return '하루 안';
  if (tradingDays < 10) return `${Math.round(tradingDays)}거래일`;
  if (tradingDays < 60) return `약 ${Math.round(tradingDays / 20)}개월`;
  if (tradingDays < 250) return `약 ${Math.round(tradingDays / 20)}개월`;
  return `약 ${(tradingDays / 250).toFixed(tradingDays % 250 === 0 ? 0 : 1)}년`;
}

/**
 * 지평 목록. 순서가 곧 화면 순서다.
 *
 * status는 **지금 사실**이어야 한다. 만들지 않은 걸 'live'로 두면 보드가 거짓말을
 * 시작하고, 그러면 이 파일이 존재할 이유가 없어진다.
 */
export const HORIZON_BOARD: HorizonSpec[] = [
  {
    key: 'm10',
    label: '10분 뒤',
    tradingDays: 0.026,
    needs: '분 단위 실시간 수집',
    status: 'no_data',
    note: '10분마다 수집이 있어야 성립한다. 지금 인프라(시간당 크론)로는 안 되고, 분봉으로 사후에 격자를 채우는 건 예측이 아니라 재현이다. 상시 프로세스를 붙일지는 별개 결정.',
  },
  {
    key: 'h1',
    label: '1시간 뒤',
    tradingDays: 0.15,
    needs: '장중 궤적·프로그램 수급·분봉',
    status: 'live',
    kind: 'directional_h1',
    note: '수집이 일어난 시각에 예측하고, 정확히 60분 뒤 분봉으로 채점한다. 마감 1시간 전부터는 대상이 장 밖이라 내지 않는다.',
  },
  {
    key: 'd0',
    label: '오늘 마감',
    tradingDays: 0.5,
    needs: '장중 궤적·수급·시장',
    status: 'live',
    kind: 'directional_d0',
    note: '매 수집마다 "지금 가격 대비 오늘 종가"를 기록한다. 하루 5~6건씩 쌓여 시간대별 신뢰도 곡선이 나온다.',
  },
  {
    key: 'd1o',
    label: '다음 장 시가',
    tradingDays: 0.7,
    needs: '간밤 SOX·나스닥·ADR 괴리',
    status: 'not_built',
    note: '갭은 간밤 미국장이 대부분 설명한다. 재료는 이미 모으고 있다.',
  },
  {
    key: 'd1',
    label: '다음 장 마감',
    tradingDays: 1,
    needs: '추세·수급·상대강도',
    status: 'live',
    kind: 'directional_1d',
    note: '',
  },
  {
    key: 'w0',
    label: '이번 주 마감',
    tradingDays: 3,
    needs: 'd1과 같은 재료',
    status: 'not_built',
    note: '남은 거래일 수에 따라 지평이 매일 달라져 별도 처리가 필요하다.',
  },
  {
    key: 'w1',
    label: '다음 주',
    tradingDays: 5,
    needs: '추세·수급·상대강도',
    status: 'live',
    kind: 'directional',
    note: '',
  },
  {
    key: 'm1',
    label: '다음 달',
    tradingDays: 20,
    needs: '업황 모멘텀·실적 시즌',
    status: 'not_built',
    note: '엔진에 지평만 더하면 되지만, 30표본까지 2.4년이 걸린다.',
  },
  {
    key: 'm2',
    label: '2달 뒤',
    tradingDays: 40,
    needs: '실적 추정 변화·사이클',
    status: 'position_only',
    note: '방향 예측은 검증에 4.8년이 걸려 내지 않는다.',
  },
  {
    key: 'm6',
    label: '6달 뒤',
    tradingDays: 120,
    needs: '실적 사이클·밸류에이션',
    status: 'position_only',
    note: '방향 예측은 검증에 14년이 걸려 내지 않는다.',
  },
  {
    key: 'y1',
    label: '1년 뒤',
    tradingDays: 250,
    needs: '실적 사이클·밸류에이션',
    status: 'position_only',
    note: '한 종목만 추적하면 연 1표본이다. 검증에 30년 — 방향은 내지 않는다.',
  },
];
