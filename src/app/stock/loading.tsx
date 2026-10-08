import { Header } from '@/app/components/Header';

/**
 * 첫 진입 때의 대기 화면.
 *
 * 기간을 바꿀 때는 `PeriodLink`의 덮개가 직전 순위를 남긴 채 흐리게 덮지만, 처음
 * 들어올 때는 덮을 내용이 없다. 그때는 이쪽이 뜬다.
 *
 * 줄 틀을 미리 깔아두는 이유는 **레이아웃이 튀지 않게** 하기 위해서다. 글자만 띄우면
 * 데이터가 도착하는 순간 화면이 통째로 밀려 올라간다.
 */
export default function Loading() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">테마 보드</h1>
          <span
            className="flex items-center gap-2 text-xs text-zinc-500"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300"
            />
            데이터를 불러오고 있습니다
          </span>
        </div>

        <div className="flex gap-1">
          {['1일', '1주', '1개월', '3개월', '6개월', '1년'].map((l) => (
            <span
              key={l}
              className="px-2.5 py-1 rounded border border-zinc-200 text-zinc-300 text-xs dark:border-zinc-800 dark:text-zinc-700"
            >
              {l}
            </span>
          ))}
        </div>

        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 animate-pulse">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="border-t border-zinc-100 dark:border-zinc-900 first:border-t-0 py-2.5 flex items-center gap-2"
            >
              <span className="w-5 h-3 rounded bg-zinc-100 dark:bg-zinc-900" />
              <span className="flex-1 h-3 rounded bg-zinc-100 dark:bg-zinc-900" />
              <span className="w-[72px] h-3 rounded bg-zinc-100 dark:bg-zinc-900" />
              <span className="w-16 h-3 rounded bg-zinc-100 dark:bg-zinc-900" />
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
