/**
 * 테마 보드 — 테마별 가격 추이와 상승률을 모아 순위를 낸다.
 *
 * ## 왜 선 14개를 겹쳐 그리지 않나
 * 한 그래프에 테마를 전부 겹치면 **스파게티**가 된다. 색 14개를 구분해야 하고,
 * 390px 폰에서는 범례만으로 화면이 찬다. 보드가 답할 질문은 "어느 테마가 지금
 * 뜨거운가"이고, 그건 **순위 한 줄**이면 답이 된다. 그래서 행마다 작은 스파크라인을
 * 두고 모양만 보여주며, 정확한 값은 펼치기에서 읽는다.
 *
 * ## 정규화
 * 반도체는 14만원대, 전고체ESS는 9천원대다. 절대가격을 겹치면 비교가 불가능하므로
 * 창 시작을 100으로 맞춘다. 스파크라인은 각자 자기 범위로 그려 **모양**을 보여주고,
 * 테마 간 **크기** 비교는 숫자(상승률)가 한다 — 선 높이로 비교하게 두면 축이 달라서
 * 거짓말이 된다.
 *
 * ## 기간이 짧은 테마
 * 상장한 지 얼마 안 된 테마는 3개월 창을 다 못 채운다. 창을 공통 구간으로 자르면
 * (한때 백테스트가 그랬듯) 가장 어린 테마가 전체를 3개월로 끌어내린다. 보드는 각자
 * 가진 만큼 그리고 **몇 거래일짜리인지 같이 적는다** — 짧은 선을 긴 선과 나란히 두되
 * 그게 짧다는 걸 숨기지 않는 쪽이 정직하다.
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockSnapshots } from '@/db/schema';
import {
  BENCHMARKS,
  BOARD_SORT_DAYS,
  THEMES,
  THEME_UNIVERSE,
  byCode,
  type ThemeEtf,
} from './theme-universe';

/**
 * 조회 창은 **선택한 기간에 맞춰 늘린다.**
 *
 * 100일로 고정해두면 1년 버튼을 눌러도 100일치만 읽혀서, 데이터가 DB에 있는데도 선이
 * 끊긴다. 반대로 항상 1년을 읽으면 1일 보기에서도 25종목 × 250일을 긁는다. 선택분에
 * 여유를 더해 읽되, 펼치기의 1주·1개월·3개월 숫자가 항상 나와야 하므로 하한은 100일.
 */
const queryDays = (sortDays: number) => Math.max(sortDays + 20, 100);

export interface ThemePoint {
  date: string;
  close: number;
  /** 창 시작을 100으로 맞춘 값 */
  indexed: number;
}

export interface ThemeRow {
  etf: ThemeEtf;
  points: ThemePoint[];
  /** 최신 종가 */
  last: number | null;
  /** 최신 거래일 */
  asOf: string | null;
  /** 선택한 창의 상승률 (%). 정렬 기준이자 행에 크게 나가는 숫자 */
  ret: number | null;
  /** 참고용 고정 창들. 선택과 무관하게 펼치기에 같이 보여준다 */
  ret1w: number | null;
  ret1m: number | null;
  ret3m: number | null;
  /** 창 안에 실제로 있는 거래일 수 — 짧은 선을 화면이 설명하는 근거 */
  tradingDays: number;
}

export interface ThemeBoard {
  themes: ThemeRow[];
  benchmarks: ThemeRow[];
  /** 모든 계열을 통틀어 가장 최근 거래일 */
  asOf: string | null;
  /** 이 보드가 정렬에 쓴 창 (일) */
  sortDays: number;
  /**
   * 지금 가진 이력의 길이(달력일). **테마들의 중앙값**이다.
   *
   * 최댓값을 쓰면 오래된 ETF 두세 개 때문에 1년 버튼이 열리고, 정작 20개는 선이 짧게
   * 끊긴다. 최솟값을 쓰면 갓 상장한 테마 하나가 전체를 막는다. 중앙값이면 "대부분의
   * 테마가 그만큼 가지고 있다"가 된다.
   */
  spanDays: number;
  /**
   * 테마와 기준선을 **한 줄로 섞어** 정렬한 목록.
   *
   * 예전엔 "나스닥100보다 나은 테마 6/14" 같은 집계 박스를 따로 뒀는데, 지수를 목록
   * 안에 끼워 넣으면 그 숫자를 셀 필요가 없다 — 지수 줄 **위에 있는 것들**이 이긴
   * 테마다. 세어서 알려주는 것보다 눈이 바로 읽는 쪽이 낫고, 어느 테마가 어느
   * 지수와 어느 정도 차이로 갈리는지까지 덤으로 보인다.
   */
  ranked: ThemeRow[];
}

const num = (p: unknown, k: string): number => {
  const v = Number((p as Record<string, unknown> | null)?.[k]);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * `days` 전 **이전 또는 같은** 날의 종가를 찾아 수익률을 낸다.
 *
 * 정확히 N일 전 봉을 찾으면 그 날이 휴장일일 때 null이 되고, 휴장이 잦은 구간에서
 * 테마마다 제각기 비는 칸이 생긴다. 이전 날로 물러나면 항상 값이 나오고, 기준일이
 * 하루 이틀 흔들리는 비용은 주간·월간 창에서 무시할 만하다.
 */
function returnOver(points: ThemePoint[], days: number): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const target = new Date(`${last.date}T00:00:00Z`).getTime() - days * 86400000;
  let base: ThemePoint | null = null;
  for (const p of points) {
    if (new Date(`${p.date}T00:00:00Z`).getTime() <= target) base = p;
    else break;
  }
  // 창이 통째로 기준일보다 짧으면(갓 상장한 테마) 비교 대상이 없다 — 0%로 적으면
  // "안 움직였다"로 읽히므로 null로 둔다.
  if (!base || base.close <= 0 || base === last) return null;
  return ((last.close - base.close) / base.close) * 100;
}

/**
 * 보드가 고를 수 있는 창.
 *
 * 한때 `BOARD_SORT_DAYS` 하나로 고정했었다. "창을 바꿔가며 보면 사후 최적화"라는
 * 이유였는데, 그건 **규칙을 고르는 맥락**의 논리였다. 이 보드는 규칙을 고르지 않고
 * 지금 사실을 보여줄 뿐이라, 같은 사실을 여러 창으로 보는 건 최적화가 아니라 관찰이다.
 * 하루짜리는 노이즈가 지배하고 분기짜리는 "지금"이 아니라서, 그 사이를 고르게 한다.
 */
/**
 * 창마다 **그 창을 실제로 계산할 수 있는지**를 `minSpan`으로 건다.
 *
 * 규칙은 간단하다: **창 길이만큼의 이력이 있어야 연다.** 365일 수익률은 365일 전
 * 종가가 있어야 나오고, 없으면 그 칸은 `—`다.
 *
 * 처음엔 "창의 절반"으로 뒀다가 실제로 깨졌다. 이력 180일에서 1년 버튼이 열렸는데,
 * 1년 수익률을 낼 수 있는 건 예전에 긴 백필을 받은 3종목뿐이라 **나머지 22줄이 전부
 * `—`인 화면**이 됐다. 순위가 셋만 매겨지고 스물둘은 번호도 없는 목록은 보드가 아니다.
 * 절반이 차면 "그려는 지는" 게 맞지만 **수익률 숫자는 절반으로 못 만든다** — 선과
 * 숫자 중 숫자가 이 화면의 본체라, 숫자 기준으로 연다.
 */
export const BOARD_WINDOWS = [
  // `intraday`는 일봉이 아니라 **오늘 장중 버킷**을 읽는다. 일봉은 마감 후에야 확정돼서
  // (18:50 수집) 장중에 '1일'을 눌러도 어제·그제 종가 두 점만 나온다 — 열어보면 오늘이
  // 없다. 장이 도는 동안 보고 싶은 건 그게 아니라 **시가 대비 지금**이다.
  { days: 0, label: '오늘', minSpan: 0, intraday: true },
  { days: 1, label: '1일', minSpan: 0 },
  { days: 7, label: '1주', minSpan: 7 },
  { days: 30, label: '1개월', minSpan: 30 },
  { days: 90, label: '3개월', minSpan: 90 },
  { days: 180, label: '6개월', minSpan: 180 },
  { days: 365, label: '1년', minSpan: 365 },
] as const;

export function resolveWindow(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && BOARD_WINDOWS.some((w) => w.days === n) ? n : BOARD_SORT_DAYS;
}

/** 0은 "오늘(장중)" 창이다. */
export const isIntradayWindow = (days: number) => days === 0;

/** 이력이 모자라 아직 못 여는 창인가. */
export function windowLocked(w: { minSpan: number }, spanDays: number): boolean {
  return spanDays < w.minSpan;
}

/**
 * 오늘 장중 추이. **시가를 첫 점으로 깔고** 시간 버킷을 잇는다.
 *
 * 시가를 넣는 이유는 둘이다. 수집이 한 번밖에 안 돈 날에도 선이 생기고("장 시작부터
 * 현재까지"가 질문이므로 시작점이 있어야 한다), 수익률 기준이 전일 종가가 아니라
 * **오늘 시가**가 되어 갭을 빼고 장중 움직임만 본다.
 *
 * 장중 cron은 하루 일곱 번 예정인데 GitHub Actions가 혼잡하면 거른다. 점이 한둘뿐인
 * 날이 흔하고, 그건 선이 거칠다는 뜻이지 값이 틀렸다는 뜻은 아니다.
 */
async function loadIntraday(codes: string[]): Promise<Map<string, ThemePoint[]>> {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      symbol: stockSnapshots.symbol,
      bucketKey: stockSnapshots.bucketKey,
      payload: stockSnapshots.payload,
    })
    .from(stockSnapshots)
    .where(
      and(
        eq(stockSnapshots.metric, 'intraday_price'),
        inArray(stockSnapshots.symbol, codes),
        gte(stockSnapshots.bucketKey, today),
      ),
    )
    .orderBy(stockSnapshots.symbol, stockSnapshots.bucketKey);

  const out = new Map<string, ThemePoint[]>();
  for (const r of rows) {
    const price = num(r.payload, 'price');
    const open = num(r.payload, 'open');
    if (!Number.isFinite(price) || price <= 0) continue;
    let list = out.get(r.symbol);
    if (!list) {
      list = [];
      // 시가는 '09:00' 자리에 둔다. 실제 체결 시각이 아니라 기준점이라는 뜻이다.
      if (Number.isFinite(open) && open > 0) {
        list.push({ date: `${today}T09:00+09:00`, close: open, indexed: 100 });
      }
      out.set(r.symbol, list);
    }
    const base = list[0]?.close ?? price;
    list.push({ date: r.bucketKey, close: price, indexed: (price / base) * 100 });
  }
  return out;
}

export async function getThemeBoard(sortDays = BOARD_SORT_DAYS): Promise<ThemeBoard> {
  const codes = THEME_UNIVERSE.map((t) => t.code);
  const since = new Date(Date.now() + 9 * 3_600_000 - queryDays(sortDays) * 86400000)
    .toISOString()
    .slice(0, 10);

  // 이력 길이는 **집계로 따로** 묻는다. 행을 다 끌어와서 세면 1년 버튼의 개방 여부를
  // 알려고 1년치를 읽어야 하는 모순이 생긴다.
  const coverage = await db
    .select({
      symbol: stockSnapshots.symbol,
      first: sql<string>`min(${stockSnapshots.bucketKey})`,
      last: sql<string>`max(${stockSnapshots.bucketKey})`,
    })
    .from(stockSnapshots)
    .where(
      and(eq(stockSnapshots.metric, 'daily_ohlcv'), inArray(stockSnapshots.symbol, codes)),
    )
    .groupBy(stockSnapshots.symbol);

  const intraday = isIntradayWindow(sortDays);
  const intradayBy = intraday ? await loadIntraday(codes) : new Map<string, ThemePoint[]>();

  const themeCodes = new Set(THEMES.map((t) => t.code));
  const spans = coverage
    .filter((c) => themeCodes.has(c.symbol))
    .map((c) =>
      Math.round(
        (new Date(`${c.last}T00:00:00Z`).getTime() -
          new Date(`${c.first}T00:00:00Z`).getTime()) /
          86400000,
      ),
    )
    .sort((a, b) => a - b);
  const spanDays = spans.length ? spans[Math.floor(spans.length / 2)]! : 0;

  // 한 번에 전부 읽는다 — 17종목을 따로 조회하면 왕복이 17번이다.
  const rows = await db
    .select({
      symbol: stockSnapshots.symbol,
      bucketKey: stockSnapshots.bucketKey,
      payload: stockSnapshots.payload,
    })
    .from(stockSnapshots)
    .where(
      and(
        eq(stockSnapshots.metric, 'daily_ohlcv'),
        inArray(stockSnapshots.symbol, codes),
        gte(stockSnapshots.bucketKey, since),
      ),
    )
    .orderBy(stockSnapshots.symbol, stockSnapshots.bucketKey);

  const bySymbol = new Map<string, { date: string; close: number }[]>();
  for (const r of rows) {
    const close = num(r.payload, 'close');
    if (!Number.isFinite(close) || close <= 0) continue;
    const list = bySymbol.get(r.symbol) ?? [];
    list.push({ date: r.bucketKey, close });
    bySymbol.set(r.symbol, list);
  }

  // 테마 분류는 payload가 아니라 **코드로** 찾는다. 백필 이전에 들어온 행에는
  // theme_label이 없고, ETF를 교체해도 payload는 과거를 그대로 들고 있기 때문이다.
  const build = (etf: ThemeEtf): ThemeRow => {
    // 오늘 창은 장중 점을 쓰고, 수익률도 **오늘 시가 대비**로 낸다. 일봉 기준
    // returnOver를 그대로 쓰면 어제 종가와 비교하게 되어 갭이 섞인다.
    if (intraday) {
      const pts = intradayBy.get(etf.code) ?? [];
      const first = pts[0], last = pts[pts.length - 1];
      const ret =
        first && last && last !== first && first.close > 0
          ? ((last.close - first.close) / first.close) * 100
          : null;
      const daily = bySymbol.get(etf.code) ?? [];
      const dailyPts: ThemePoint[] = daily.map((p) => ({ ...p, indexed: 100 }));
      return {
        etf,
        points: pts,
        last: last?.close ?? null,
        asOf: last?.date.slice(0, 10) ?? null,
        ret,
        ret1w: returnOver(dailyPts, BOARD_SORT_DAYS),
        ret1m: returnOver(dailyPts, 30),
        ret3m: returnOver(dailyPts, 90),
        tradingDays: pts.length,
      };
    }
    const raw = bySymbol.get(etf.code) ?? [];
    const first = raw[0]?.close ?? 0;
    const points: ThemePoint[] = raw.map((p) => ({
      ...p,
      indexed: first > 0 ? (p.close / first) * 100 : 100,
    }));
    const last = points[points.length - 1] ?? null;
    return {
      etf,
      points,
      last: last?.close ?? null,
      asOf: last?.date ?? null,
      ret: returnOver(points, sortDays),
      ret1w: returnOver(points, BOARD_SORT_DAYS),
      ret1m: returnOver(points, 30),
      ret3m: returnOver(points, 90),
      tradingDays: points.length,
    };
  };

  // 정렬: 1주 상승률 내림차순. 데이터가 없어 null인 줄은 맨 아래로 — 0%로 셈하면
  // 빠진 테마가 중간에 끼어 "보합이었다"로 읽힌다.
  const themes = THEMES.map(build).sort(
    (a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity),
  );
  const benchmarks = BENCHMARKS.map(build).sort(
    (a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity),
  );

  const ranked = [...themes, ...benchmarks].sort(
    (a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity),
  );

  // 기준일은 **국내 계열**에서 뽑는다. 전체 최댓값을 쓰면 국내 휴장일(한글날 등)에
  // 미국장이 열린 ETHU 하나 때문에 헤더가 하루 앞서가고, 정작 모든 테마 줄은 그
  // 전날 값이라 "오늘 자료"로 오해하게 된다.
  const kr = [...themes, ...benchmarks].filter((r) => r.etf.market === 'kr');
  const asOf =
    (kr.length ? kr : [...themes, ...benchmarks])
      .map((r) => r.asOf)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;

  return { themes, benchmarks, ranked, asOf, sortDays, spanDays };
}

/** 코드 → 테마. 화면이 payload를 뒤지지 않게 한다. */
export { byCode };

/** 수급 패널이 읽을 일별 투자자 순매수 (백만원). ETF도 이 API가 동작한다(프로브 확인). */
export interface FlowPoint {
  date: string;
  foreign: number;
  institution: number;
  individual: number;
}

/**
 * 전 종목 수급을 **한 번에** 읽는다.
 *
 * 펼치기 패널마다 조회하면 `<details>`가 열리든 말든 서버에서 17번 왕복한다 — 서버
 * 컴포넌트는 접힌 내용도 미리 렌더하기 때문이다.
 */
export async function getThemeFlows(days = 30): Promise<Map<string, FlowPoint[]>> {
  const since = new Date(Date.now() + 9 * 3_600_000 - days * 86400000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({
      symbol: stockSnapshots.symbol,
      bucketKey: stockSnapshots.bucketKey,
      payload: stockSnapshots.payload,
    })
    .from(stockSnapshots)
    .where(
      and(
        eq(stockSnapshots.metric, 'investor_flow'),
        inArray(stockSnapshots.symbol, THEME_UNIVERSE.map((t) => t.code)),
        gte(stockSnapshots.bucketKey, since),
      ),
    )
    .orderBy(sql`${stockSnapshots.bucketKey} desc`);

  const out = new Map<string, FlowPoint[]>();
  for (const r of rows) {
    const f = {
      date: r.bucketKey,
      foreign: num(r.payload, 'foreign_net'),
      institution: num(r.payload, 'institution_net'),
      individual: num(r.payload, 'individual_net'),
    };
    if (!Number.isFinite(f.foreign)) continue;
    out.set(r.symbol, [...(out.get(r.symbol) ?? []), f]);
  }
  return out;
}
