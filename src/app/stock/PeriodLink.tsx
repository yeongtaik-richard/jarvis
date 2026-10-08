'use client';

import Link from 'next/link';
import { useLinkStatus } from 'next/link';

/**
 * 기간 선택 링크 + **대기 중 화면 덮개.**
 *
 * `/stock`은 `force-dynamic`이라 기간을 누를 때마다 서버에서 다시 읽는다. 25종목 ×
 * 최대 1년치를 긁으므로 체감이 되는 시간이고, 그동안 화면이 멀쩡해 보이면 "눌렸나?"
 * 하고 한 번 더 누르게 된다.
 *
 * `loading.tsx`가 아니라 덮개인 이유: 저쪽은 콘텐츠를 **교체**해서 보던 목록이 사라진다.
 * 기간만 바꾸는 참이라 직전 순위를 남겨두고 그 위에 흐리게 덮는 쪽이 맥락이 안 끊긴다.
 *
 * `useLinkStatus`는 `<Link>` **하위에서만** 동작하고, 프리페치가 끝난 링크는 pending을
 * 건너뛴다 — 그래서 `prefetch={false}`가 필요하다. 어차피 매번 서버를 타는 페이지라
 * 프리페치로 얻을 게 없다.
 */
function PendingVeil() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      // 고정 위치라 링크 안에 있어도 화면 전체를 덮는다. 포인터는 통과시키지 않아
      // 대기 중 연타를 막는다.
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] bg-white/40 dark:bg-black/40"
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300"
        />
        데이터를 불러오고 있습니다
      </span>
    </span>
  );
}

export function PeriodLink({
  days,
  label,
  active,
}: {
  days: number;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={`/stock?d=${days}`}
      prefetch={false}
      className={`px-2.5 py-1 rounded border ${
        active
          ? 'border-zinc-400 bg-zinc-100 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
          : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
      }`}
    >
      {label}
      <PendingVeil />
    </Link>
  );
}
