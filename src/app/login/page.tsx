import { isLoggedIn } from '@/lib/web-auth';
import { loginAction } from './actions';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Search = { error?: string; returnTo?: string };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  if (await isLoggedIn()) redirect('/');
  const { error, returnTo } = await searchParams;
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form
        action={loginAction}
        className="w-full max-w-sm space-y-4 bg-white dark:bg-zinc-900 p-6 rounded-lg shadow"
      >
        <h1 className="text-2xl font-semibold">Jarvis</h1>
        <p className="text-sm text-zinc-500">웹 비밀번호를 입력하세요.</p>
        <input
          type="password"
          name="password"
          autoFocus
          required
          className="w-full px-3 py-2 border rounded bg-transparent"
          placeholder="JARVIS_WEB_PASSWORD"
        />
        <input type="hidden" name="returnTo" value={returnTo ?? '/'} />
        {error === 'invalid' && (
          <p className="text-sm text-red-600">비밀번호가 틀렸습니다.</p>
        )}
        <button
          type="submit"
          className="w-full py-2 rounded bg-zinc-900 text-white dark:bg-white dark:text-black"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
