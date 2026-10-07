/**
 * 테마 보드 유니버스 — **테마 하나당 대표 ETF 하나.**
 *
 * ## 뼈대는 DC 계좌 보유 종목이다
 * 테마를 머리로 정하지 않고 **리처드님이 실제로 들고 있는 ETF에서 가져왔다**(`held`).
 * 이미 돈을 넣어 고른 것들이라 테마 정의에 실감이 있고, 보드가 "내 포트폴리오가 지금
 * 어디 서 있나"를 바로 답한다. 보유에 없는 테마는 비교 대상으로 덧붙였다(`held: false`)
 * — "내가 안 든 쪽이 더 뜨거운가"가 이 화면의 쓸모 중 하나다.
 *
 * ## 테마를 ETF 하나로 대신하는 이유
 * 테마를 종목 바스켓으로 구성하면 "그 테마의 대표 종목이 무엇인가"라는 **또 하나의
 * 판단**이 들어가고, 그게 틀리면 테마 추이가 아니라 종목 선택 결과를 보게 된다. ETF는
 * 그 판단을 운용사가 지수 규칙으로 이미 했고 편입·퇴출도 당시 기준으로 처리한다.
 *
 * ## 운용사가 섞인다 — 알고 섞는다
 * 한때 "전부 KODEX로 통일"을 생각했다. 지수 구성 철학이 같으면 테마 간 수익률 차이에
 * "지수 만드는 방식이 달라서"가 안 섞이기 때문이다. 그런데 보유가 KODEX·RISE·ACE에
 * 걸쳐 있고, **보드의 목적이 "내가 든 것의 추이"**라 보유를 그대로 쓰는 쪽이 맞다.
 *
 * 대가는 `ai_power`와 `ai_power_infra`에서 가장 크게 드러난다. 둘은 겹치는 테마인데
 * 운용사도 지수도 달라서, 선이 벌어질 때 **"테마가 달라서"와 "지수가 달라서"를 가를
 * 수 없다.** 그래서 라벨에 운용사를 남긴다 — 화면이 그 한계를 숨기지 않게.
 *
 * ## 채권 혼합형과 TDF는 뺐다
 * 보유 중이지만 테마 줄에 올리지 않는다:
 * - `1Q K반도체TOP2채권혼합50`, `1Q 미국나스닥100미국채혼합50액티브` — **채권이 절반**이라
 *   기초 테마가 10% 올라도 5%만 오른다. 같은 보드에 올리면 "반도체"가 두 줄인데 하나는
 *   절반만 움직이는 꼴이 되어 상승률 순위가 뜻을 잃는다.
 * - `KODEX TDF2050액티브` — 생애주기 자산배분이라 테마가 아니다.
 *
 * ## 지수는 테마가 아니다
 * 코스피200·나스닥100·S&P500은 `kind: 'benchmark'`다. **상승률 순위에 같이 세우지
 * 않는다** — 분산된 지수가 단일 테마보다 덜 움직이는 건 산수지 정보가 아니라서, 섞어
 * 정렬하면 보드 중간에 의미 없는 줄이 생긴다. 대신 기준선으로 쓴다: "테마 13개 중
 * 나스닥100을 이긴 건 몇 개인가". 전부 오르는 장에서는 전부 뜨거워 보이고, 그걸
 * 가려내는 게 기준선의 일이다.
 */

export interface ThemeEtf {
  /** 식별자 — 차트 계열을 이 키로 묶는다 */
  key: string;
  /** 화면에 나가는 이름. ETF 정식명이 아니라 **테마**를 부른다 */
  label: string;
  /** KRX 종목코드 */
  code: string;
  /** ETF 정식 명칭 — 출처를 숨기지 않는다 */
  name: string;
  /** 운용사. 같은 테마가 운용사별로 다를 수 있어 화면에 같이 띄운다 */
  issuer: 'KODEX' | 'RISE' | 'ACE' | 'TIGER';
  /**
   * 상장일 (YYYY-MM-DD). 수집 창을 자르고 "상장 N개월" 표기에 쓴다.
   *
   * ⚠️ `dateChecked: false`는 **미검증 추정치**다. 수집하면 첫 봉이 진짜 상장일을
   * 알려주므로 데이터가 들어온 뒤 실측으로 고친다. 추정이 실제보다 이르면 KIS가 빈
   * 구간을 안 줄 뿐이라 손해가 없고, 늦으면 데이터를 잃는다 — 확신 없으면 **이른 쪽**.
   */
  listedOn: string;
  dateChecked: boolean;
  /** DC 계좌에 실제로 들고 있는가 (2026-10-07 잔고 기준) */
  held: boolean;
  /**
   * 기초자산이 국내인가 해외인가.
   *
   * 섞어 보여주되 **라벨은 붙인다** — 해외물은 환율이 수익률에 섞이고, 기초자산 장이
   * 한국 장중에 닫혀 있어 "오늘 장중 추이"의 의미가 다르다.
   */
  market: 'kr' | 'us';
  kind: 'theme' | 'benchmark';
  group: string;
}

export const THEME_UNIVERSE: ThemeEtf[] = [
  // ── 반도체. 넷으로 쪼갠 이유: 같은 "반도체"라도 대형주·장비·미국이 서로 다른 시점에
  //    움직인다. 하나로 뭉치면 그 차이가 안 보인다. 다만 091160과 395160은 구성이
  //    상당히 겹쳐(둘 다 삼성전자·하이닉스 중심) 선이 비슷하게 갈 수 있다.
  { key: 'semi_kr', label: '반도체', code: '091160', name: 'KODEX 반도체',
    issuer: 'KODEX', listedOn: '2006-06-27', dateChecked: true, held: true,
    market: 'kr', kind: 'theme', group: '반도체' },
  { key: 'semi_equip', label: '반도체 장비', code: '471990', name: 'KODEX AI반도체핵심장비',
    issuer: 'KODEX', listedOn: '2023-11-21', dateChecked: true, held: true,
    market: 'kr', kind: 'theme', group: '반도체' },
  { key: 'semi_top2', label: '반도체 대형주', code: '395160', name: 'KODEX AI반도체TOP2플러스',
    issuer: 'KODEX', listedOn: '2021-01-01', dateChecked: false, held: false,
    market: 'kr', kind: 'theme', group: '반도체' },
  { key: 'semi_us', label: '미국 반도체', code: '390390', name: 'KODEX 미국반도체',
    issuer: 'KODEX', listedOn: '2021-06-30', dateChecked: true, held: false,
    market: 'us', kind: 'theme', group: '반도체' },

  // ── AI 인프라. ai_power와 ai_power_infra는 겹치는 테마다 (상단 주석 §운용사 참고).
  { key: 'ai_power', label: 'AI 전력설비', code: '487240', name: 'KODEX AI전력핵심설비',
    issuer: 'KODEX', listedOn: '2024-07-09', dateChecked: true, held: true,
    market: 'kr', kind: 'theme', group: 'AI 인프라' },
  { key: 'ai_power_infra', label: 'AI 전력인프라', code: '0101N0', name: 'RISE AI전력인프라',
    issuer: 'RISE', listedOn: '2025-09-23', dateChecked: true, held: true,
    market: 'kr', kind: 'theme', group: 'AI 인프라' },
  { key: 'optical', label: 'AI 광통신', code: '0173Y0', name: 'KODEX 미국AI광통신네트워크',
    issuer: 'KODEX', listedOn: '2026-03-31', dateChecked: true, held: false,
    market: 'us', kind: 'theme', group: 'AI 인프라' },

  // ── 에너지·중공업
  { key: 'nuclear', label: '원전', code: '433500', name: 'ACE 원자력TOP10',
    issuer: 'ACE', listedOn: '2022-06-28', dateChecked: true, held: true,
    market: 'kr', kind: 'theme', group: '에너지·중공업' },
  { key: 'ess', label: '전고체·ESS', code: '0209D0', name: 'KODEX 전고체배터리ESS TOP2플러스',
    issuer: 'KODEX', listedOn: '2026-06-23', dateChecked: true, held: true,
    market: 'kr', kind: 'theme', group: '에너지·중공업' },
  { key: 'defense', label: '방산', code: '0080G0', name: 'KODEX 방산TOP10',
    issuer: 'KODEX', listedOn: '2025-01-01', dateChecked: false, held: false,
    market: 'kr', kind: 'theme', group: '에너지·중공업' },
  { key: 'shipbuilding', label: '조선', code: '0115D0', name: 'KODEX 조선TOP10',
    issuer: 'KODEX', listedOn: '2025-01-01', dateChecked: false, held: false,
    market: 'kr', kind: 'theme', group: '에너지·중공업' },

  // ── 기타
  { key: 'robot', label: '로봇', code: '445290', name: 'KODEX 로봇액티브',
    issuer: 'KODEX', listedOn: '2022-01-01', dateChecked: false, held: false,
    market: 'kr', kind: 'theme', group: '기타' },
  { key: 'space', label: '미국 우주항공', code: '0167Z0', name: 'KODEX 미국우주항공',
    issuer: 'KODEX', listedOn: '2026-03-17', dateChecked: true, held: false,
    market: 'us', kind: 'theme', group: '기타' },
  { key: 'cyber', label: 'AI 사이버보안', code: '418670', name: 'TIGER 글로벌AI사이버보안',
    issuer: 'TIGER', listedOn: '2022-02-22', dateChecked: true, held: false,
    market: 'us', kind: 'theme', group: '기타' },

  // ── 기준선. 순위에 섞지 않는다 (상단 주석 §지수는 테마가 아니다).
  { key: 'kospi200', label: '코스피 200', code: '148020', name: 'RISE 200',
    issuer: 'RISE', listedOn: '2011-10-20', dateChecked: true, held: true,
    market: 'kr', kind: 'benchmark', group: '기준선' },
  { key: 'nasdaq100', label: '나스닥 100', code: '379810', name: 'KODEX 미국나스닥100',
    issuer: 'KODEX', listedOn: '2021-01-01', dateChecked: false, held: true,
    market: 'us', kind: 'benchmark', group: '기준선' },
  { key: 'sp500', label: 'S&P 500', code: '379800', name: 'KODEX 미국S&P500',
    issuer: 'KODEX', listedOn: '2021-01-01', dateChecked: false, held: true,
    market: 'us', kind: 'benchmark', group: '기준선' },
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
