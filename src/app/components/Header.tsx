import Link from 'next/link';
import { logoutAction } from '@/app/login/actions';

export function Header() {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      {/* 390px에서 nav 5개가 한 줄 flex라 넘쳤다 — 가로 스크롤 + 축약 라벨 (codex 리뷰). */}
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-3">
        <Link href="/" className="font-semibold shrink-0 py-2">
          Jarvis
        </Link>
        <nav className="flex gap-4 text-sm text-zinc-600 dark:text-zinc-400 overflow-x-auto whitespace-nowrap min-w-0 flex-1">
          <Link href="/" className="shrink-0 py-2 hover:text-zinc-900 dark:hover:text-zinc-100">
            Memories
          </Link>
          <Link href="/new" className="shrink-0 py-2 hover:text-zinc-900 dark:hover:text-zinc-100">
            New
          </Link>
          <Link
            href="/improvement"
            className="shrink-0 py-2 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Improvements
          </Link>
          <Link href="/stock" className="shrink-0 py-2 hover:text-zinc-900 dark:hover:text-zinc-100">
            Stock
          </Link>
          <Link href="/logs" className="shrink-0 py-2 hover:text-zinc-900 dark:hover:text-zinc-100">
            Logs
          </Link>
        </nav>
        <form action={logoutAction} className="shrink-0">
          <button type="submit" className="text-sm text-zinc-500 hover:text-zinc-800 py-2">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
