/**
 * KRX 거래일 달력. "N거래일 뒤"를 정확히 세기 위한 것.
 *
 * 왜 필요했나 — 없을 때 세 곳에서 샜다:
 * ① 5거래일 지평을 **캘린더 +7일**로 근사했다. 중간에 휴장일이 끼면 실제로는 4거래일인데
 *    백테스트는 정확히 5거래일이라, 둘이 다른 걸 재고 있었다.
 * ② 대상일이 휴장일인 예측은 스냅샷이 영영 안 와서 `expired`로 빠졌다 — 표본 유실.
 * ③ 휴장일에 마감 수집이 안 돌면 `missed` 경고가 떴다 (오탐).
 *
 * 두 출처를 합친다:
 * - **과거**: 저장된 일봉의 빈 평일. 백필이 KIS 연속 구간 조회라 "봉 없음 = 휴장"이
 *   확실하다(수집 누락이 아니다). 이쪽이 가장 믿을 만하다.
 * - **미래**: KIS 휴장일 조회(CTCA0903R)를 수집기가 매일 받아 저장한 스냅샷.
 *   과거는 역산되지만 미래는 역산할 수 없어서 이 API가 필요하다.
 *
 * 둘 다 없는 구간은 `knownThrough` 밖이다. 그 너머는 주말만 건너뛰는 근사가 되므로,
 * 쓰는 쪽이 그 사실을 알 수 있게 값을 같이 돌려준다.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockSnapshots } from '@/db/schema';

export const CALENDAR_METRIC = 'market_calendar';

export interface MarketCalendar {
  /** 휴장인 평일 (YYYY-MM-DD). 주말은 넣지 않는다 — 요일로 알 수 있다. */
  closed: Set<string>;
  /** 이 날짜까지는 달력을 안다. 넘어가면 주말만 거르는 근사다. */
  knownThrough: string | null;
  /** 달력을 아는 시작일 */
  knownFrom: string | null;
}

const isWeekend = (date: string): boolean => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function getMarketCalendar(symbol: string): Promise<MarketCalendar> {
  const [bars, calRows] = await Promise.all([
    db
      .select({ bucketKey: stockSnapshots.bucketKey })
      .from(stockSnapshots)
      .where(
        and(eq(stockSnapshots.symbol, symbol), eq(stockSnapshots.metric, 'daily_ohlcv')),
      )
      .orderBy(stockSnapshots.bucketKey),
    db
      .select({ payload: stockSnapshots.payload })
      .from(stockSnapshots)
      .where(
        and(eq(stockSnapshots.symbol, symbol), eq(stockSnapshots.metric, CALENDAR_METRIC)),
      )
      .orderBy(desc(stockSnapshots.bucketKey))
      .limit(1),
  ]);

  const closed = new Set<string>();
  let knownFrom: string | null = null;
  let knownThrough: string | null = null;

  // 과거 — 일봉이 있는 구간의 빈 평일
  if (bars.length > 0) {
    const have = new Set(bars.map((b) => b.bucketKey));
    knownFrom = bars[0]!.bucketKey;
    knownThrough = bars[bars.length - 1]!.bucketKey;
    for (let d = knownFrom; d <= knownThrough; d = addDays(d, 1)) {
      if (!isWeekend(d) && !have.has(d)) closed.add(d);
    }
  }

  // 미래 — 수집기가 받아둔 KIS 휴장일
  const cal = calRows[0]?.payload as
    | { from?: string; to?: string; closed?: string[] }
    | undefined;
  if (cal?.to) {
    for (const d of cal.closed ?? []) if (!isWeekend(d)) closed.add(d);
    if (!knownFrom || (cal.from && cal.from < knownFrom)) knownFrom = cal.from ?? knownFrom;
    if (!knownThrough || cal.to > knownThrough) knownThrough = cal.to;
  }

  return { closed, knownThrough, knownFrom };
}

/** 그날 장이 서는가. 달력 밖이면 주말 여부로만 판단한다. */
export function isTradingDay(date: string, cal: MarketCalendar): boolean {
  return !isWeekend(date) && !cal.closed.has(date);
}

/**
 * `from`으로부터 **N거래일 뒤**의 날짜. `from` 자신은 세지 않는다.
 *
 * 달력을 아는 범위를 넘어가면 주말만 거르는 근사가 되고 `beyondKnown`이 true다 —
 * 그 결과로 만든 예측은 대상일이 휴장일일 수 있으니 쓰는 쪽이 알아야 한다.
 */
export function nextTradingDay(
  from: string,
  n: number,
  cal: MarketCalendar,
): { date: string; beyondKnown: boolean } {
  let d = from;
  let left = n;
  // 넉넉한 상한 — 연휴가 아무리 길어도 이 안에서 끝난다
  for (let guard = 0; guard < 40 && left > 0; guard++) {
    d = addDays(d, 1);
    if (isTradingDay(d, cal)) left--;
  }
  return { date: d, beyondKnown: cal.knownThrough === null || d > cal.knownThrough };
}
