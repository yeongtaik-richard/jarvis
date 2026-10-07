/**
 * 테마 보드 유니버스 — **테마 하나당 대표 ETF 하나.**
 *
 * ## 테마를 ETF 하나로 대신하는 이유
 * 테마를 종목 바스켓으로 구성하면 "그 테마의 대표 종목이 무엇인가"라는 **또 하나의
 * 판단**이 들어가고, 그 판단이 틀리면 테마 추이가 아니라 종목 선택의 결과를 보게 된다.
 * ETF는 그 판단을 운용사가 지수 규칙으로 이미 했고, 편입·퇴출도 당시 기준으로 처리한다.
 * 화면이 답할 질문은 "어느 테마가 지금 뜨거운가"지 "어느 종목이 대표인가"가 아니다.
 *
 * ## 왜 전부 KODEX인가
 * 운용사를 섞으면 지수 구성 철학과 리밸런싱 규칙이 테마마다 달라져서, 테마 간
 * 수익률 차이에 **"테마가 달라서"와 "지수 만드는 방식이 달라서"가 섞인다.** 한 집안으로
 * 묶으면 그 교란이 줄고, 보수 수준도 비슷해 비교가 공평해진다. 리처드님 DC 계좌가
 * 이미 KODEX라 테마 정의도 일관된다.
 *
 * 대가는 있다 — KODEX에 없는 테마는 못 넣는다. 그 테마가 꼭 필요해지면 그때 예외를
 * 두되, **예외라고 적고** 넣는다.
 *
 * ## 상장일이 유니버스를 제한하지 않는다
 * 로테이션 **백테스트**를 할 때는 가장 어린 ETF가 공통 구간을 정해서 2026년 상장
 * 종목이 끼면 구간이 3개월로 쪼그라들었다. 지금은 백테스트를 접고 **추이 보드**로
 * 방향을 틀었고, 보드는 각 테마가 가진 만큼만 그리면 되므로 공통 구간이 필요 없다.
 * 어린 테마는 선이 짧게 나오고, 화면이 "상장 N개월"이라고 적으면 그걸로 정직하다.
 *
 * ## 지수는 테마가 아니다
 * 나스닥100·S&P500은 `kind: 'benchmark'`다. **상승률 순위에 같이 세우면 안 된다** —
 * 분산된 지수가 단일 테마보다 덜 움직이는 건 당연해서, 섞어 정렬하면 지수가 늘 중간에
 * 깔리는 의미 없는 줄이 생긴다. 기준선으로 써야 한다: "테마 12개 중 나스닥100을 이긴
 * 건 몇 개인가". 그게 "핫하다"에 실질을 준다 — 전부 오르는 장에서는 전부 뜨거워 보인다.
 */

export interface ThemeEtf {
  /** 식별자 — 차트 계열·비중을 이 키로 묶는다 */
  key: string;
  /** 화면에 나가는 이름. ETF 정식명이 아니라 **테마**를 부른다 */
  label: string;
  /** KRX 종목코드 */
  code: string;
  /** ETF 정식 명칭 — 출처를 숨기지 않는다 */
  name: string;
  /**
   * 상장일 (YYYY-MM-DD). 수집 창을 자르고 "상장 N개월" 표기에 쓴다.
   *
   * ⚠️ 일부는 **미검증 추정치**다(`dateChecked: false`). 수집하면 첫 봉이 진짜
   * 상장일을 알려주므로, 데이터가 들어온 뒤 실측으로 고친다. 추정이 실제보다
   * 이르면 KIS가 빈 구간을 안 줄 뿐이라 손해가 없고, 늦으면 데이터를 잃는다 —
   * 그래서 확신 없을 때는 **이른 쪽으로** 잡는다.
   */
  listedOn: string;
  /** 상장일을 공개 자료로 확인했는가. false면 수집 후 실측으로 교정할 것 */
  dateChecked: boolean;
  /**
   * 기초자산이 국내인가 해외인가.
   *
   * 섞어 보여주되 **라벨은 붙인다** — 해외물은 환율이 수익률에 섞이고, 기초자산 장이
   * 한국 장중에 닫혀 있어 "오늘 장중 추이"의 의미가 다르다. 세금도 다르다(국내주식형은
   * 매매차익 비과세, 해외형은 배당소득세).
   */
  market: 'kr' | 'us';
  /** 테마인가 비교 기준선인가 */
  kind: 'theme' | 'benchmark';
  /** 같은 큰 줄기끼리 묶어 보여주기 위한 그룹 */
  group: string;
}

export const THEME_UNIVERSE: ThemeEtf[] = [
  // ── 반도체. 넷으로 쪼갠 이유: 같은 "반도체"라도 대형주·장비·미국이 서로 다른
  //    시점에 움직인다. 하나로 뭉치면 그 차이가 안 보인다. 다만 091160과 395160은
  //    구성이 상당히 겹쳐(둘 다 삼성전자·하이닉스 중심) 선이 비슷하게 갈 수 있다.
  {
    key: 'semi_kr',
    label: '반도체 (국내 전반)',
    code: '091160',
    name: 'KODEX 반도체',
    listedOn: '2006-06-27',
    dateChecked: true,
    market: 'kr',
    kind: 'theme',
    group: '반도체',
  },
  {
    key: 'semi_top2',
    label: '반도체 대형주',
    code: '395160',
    name: 'KODEX AI반도체TOP2플러스',
    listedOn: '2021-01-01',
    dateChecked: false,
    market: 'kr',
    kind: 'theme',
    group: '반도체',
  },
  {
    key: 'semi_equip',
    label: '반도체 장비·소부장',
    code: '471990',
    name: 'KODEX AI반도체핵심장비',
    listedOn: '2023-11-21',
    dateChecked: true,
    market: 'kr',
    kind: 'theme',
    group: '반도체',
  },
  {
    key: 'semi_us',
    label: '미국 반도체',
    code: '390390',
    name: 'KODEX 미국반도체',
    listedOn: '2021-06-30',
    dateChecked: true,
    market: 'us',
    kind: 'theme',
    group: '반도체',
  },

  // ── AI 인프라
  {
    key: 'ai_power',
    label: 'AI 전력',
    code: '487240',
    name: 'KODEX AI전력핵심설비',
    listedOn: '2024-07-09',
    dateChecked: true,
    market: 'kr',
    kind: 'theme',
    group: 'AI 인프라',
  },
  {
    key: 'optical',
    label: 'AI 광통신',
    code: '0173Y0',
    name: 'KODEX 미국AI광통신네트워크',
    listedOn: '2026-03-31',
    dateChecked: true,
    market: 'us',
    kind: 'theme',
    group: 'AI 인프라',
  },

  // ── 에너지·중공업
  {
    key: 'nuclear',
    label: '원전·SMR',
    code: '0098F0',
    name: 'KODEX K원자력SMR',
    listedOn: '2025-09-16',
    dateChecked: true,
    market: 'kr',
    kind: 'theme',
    group: '에너지·중공업',
  },
  {
    key: 'ess',
    label: '전고체·ESS',
    code: '0209D0',
    name: 'KODEX 전고체배터리ESS TOP2플러스',
    listedOn: '2026-06-23',
    dateChecked: true,
    market: 'kr',
    kind: 'theme',
    group: '에너지·중공업',
  },
  {
    key: 'defense',
    label: '방산',
    code: '0080G0',
    name: 'KODEX 방산TOP10',
    listedOn: '2025-01-01',
    dateChecked: false,
    market: 'kr',
    kind: 'theme',
    group: '에너지·중공업',
  },
  {
    key: 'shipbuilding',
    label: '조선',
    code: '0115D0',
    name: 'KODEX 조선TOP10',
    listedOn: '2025-01-01',
    dateChecked: false,
    market: 'kr',
    kind: 'theme',
    group: '에너지·중공업',
  },

  // ── 기타 테마
  {
    key: 'robot',
    label: '로봇',
    code: '445290',
    name: 'KODEX 로봇액티브',
    listedOn: '2022-01-01',
    dateChecked: false,
    market: 'kr',
    kind: 'theme',
    group: '기타',
  },
  {
    key: 'space',
    label: '미국 우주항공',
    code: '0167Z0',
    name: 'KODEX 미국우주항공',
    listedOn: '2026-03-17',
    dateChecked: true,
    market: 'us',
    kind: 'theme',
    group: '기타',
  },

  // ── 기준선. 순위에 섞지 않는다 (상단 주석 §지수는 테마가 아니다 참고)
  {
    key: 'nasdaq100',
    label: '나스닥 100',
    code: '379810',
    name: 'KODEX 미국나스닥100',
    listedOn: '2021-01-01',
    dateChecked: false,
    market: 'us',
    kind: 'benchmark',
    group: '기준선',
  },
  {
    key: 'sp500',
    label: 'S&P 500',
    code: '379800',
    name: 'KODEX 미국S&P500',
    listedOn: '2021-01-01',
    dateChecked: false,
    market: 'us',
    kind: 'benchmark',
    group: '기준선',
  },
];

export const THEMES = THEME_UNIVERSE.filter((t) => t.kind === 'theme');
export const BENCHMARKS = THEME_UNIVERSE.filter((t) => t.kind === 'benchmark');

export function byCode(code: string): ThemeEtf | undefined {
  return THEME_UNIVERSE.find((t) => t.code === code);
}

/**
 * 보드 기본 정렬 — **최근 1주 상승률 내림차순.**
 *
 * "어느 테마가 지금 뜨거운가"가 이 화면의 질문이고, 1주는 그에 맞는 가장 짧은 창이다.
 * 하루는 노이즈가 지배하고(장중 한 번 출렁이면 순위가 뒤집힌다), 한 달은 "지금"이라
 * 부르기에 느리다.
 *
 * 상수로 둔 이유: 화면을 보다가 "3일로 바꿔볼까"가 반복되면 그게 사후 최적화다.
 * 바꿀 거면 커밋에 근거를 남기라는 뜻이다.
 */
export const BOARD_SORT_DAYS = 7;
