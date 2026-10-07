/**
 * `/stock` 계열 페이지가 공유하는 표시 헬퍼.
 *
 * 페이지를 셋으로 나누면서 생긴 파일이다 — 장중용 `/stock`, 검증용 `/stock/horizons`,
 * 원천 데이터용 `/stock/data`. 셋이 같이 쓰는 것만 여기 둔다. 한 페이지에서만 쓰는
 * 것은 그 페이지 옆 파일에 있다.
 */

export type Tone = 'pos' | 'neg' | 'neutral';
export type Row = { label: string; value: string; tone?: Tone; sub?: string };

// 부호 색은 국내 관례 — 빨강=순매수·상승, 파랑=순매도·하락. (emerald/rose는 색각 이상
// 판별에서 실패해서 갈아탔다. globals.css의 `.viz` 토큰과 같은 규칙.)
export const toneClass: Record<Tone, string> = {
  pos: 'text-red-600 dark:text-red-400',
  neg: 'text-blue-600 dark:text-blue-400',
  neutral: 'text-zinc-700 dark:text-zinc-300',
};

export function minutesAgo(iso: string, now: number): number {
  return Math.round((now - new Date(iso).getTime()) / 60000);
}

/** 평일 09:00~15:30 KST인가 — 신선도 경고는 장중에만 의미가 있다. */
export function isMarketHoursKst(now: number): boolean {
  const kst = new Date(now + 9 * 3_600_000);
  const dow = kst.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return min >= 9 * 60 && min <= 15 * 60 + 30;
}

/**
 * 장외·주말에는 금요일 마감 데이터가 "이틀 전"이어도 정상이라 경고색을 쓰지 않는다.
 * rose는 쓰지 않는다 — 빨강 계열은 가격·수급 방향(상승/순매수)에 예약돼 있어서
 * 상태 경고에 섞으면 관례와 충돌한다 (codex 리뷰 반영).
 */
export function freshnessBadge(mins: number, marketOpen: boolean): string {
  if (!marketOpen) return 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
  if (mins < 20) return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
  if (mins < 90) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  return 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200';
}

export function agoText(mins: number): string {
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function kstTime(iso: string | null): string {
  if (!iso) return '—';
  // ko-KR의 dateStyle:'short'는 "26. 8. 4. PM 2:51"처럼 나와 읽기 사납다.
  const d = new Date(iso);
  const f = (o: Intl.DateTimeFormatOptions) =>
    d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', ...o });
  const md = f({ month: 'numeric', day: 'numeric' }).replace(/\.\s*/g, '/').replace(/\/$/, '');
  return `${md} ${f({ hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

export function payloadNum(payload: unknown, key: string): number {
  const v = Number((payload as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) ? v : NaN;
}

/** 수집 실행 상태 — 장애 배너와 데이터 페이지가 같이 쓴다. */
export const RUN_KIND_LABEL: Record<string, string> = {
  close: '마감',
  premarket: '장 시작 전',
  intraday: '장중',
  backfill: '과거 채우기',
  manual: '수동',
  ondemand: '요청 실행',
};
/** 상태를 영문 그대로 보여주면 뭐가 문제인지 알 수 없다. */
export const RUN_STATUS_WORD: Record<string, string> = {
  ok: '정상',
  running: '진행 중',
  partial: '일부 실패',
  error: '실패',
};
export const RUN_STATUS_BADGE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  error: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};
