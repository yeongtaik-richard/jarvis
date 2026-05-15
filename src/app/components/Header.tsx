import Link from 'next/link';
import { logoutAction } from '@/app/login/actions';

export function Header() {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-4">
        <Link href="/" className="font-semibold">
          Jarvis
        </Link>
        <nav className="flex gap-3 text-sm text-zinc-600 dark:text-zinc-400">
          <Link href="/" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            Memories
          </Link>
          <Link href="/new" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            New
          </Link>
          <Link href="/improvement" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            Improvements
          </Link>
          <Link href="/logs" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            Server Logs
          </Link>
        </nav>
        <form action={logoutAction} className="ml-auto">
          <button type="submit" className="text-sm text-zinc-500 hover:text-zinc-800">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
