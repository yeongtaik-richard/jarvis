import { headers } from 'next/headers';
import { Header } from '@/app/components/Header';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Search = { code?: string; error?: string; scope?: string };

async function exchangeCode(code: string, redirectUri: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set on server' };
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  return (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
}

export default async function GoogleOauthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  if (sp.error) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-3xl mx-auto px-4 py-6 space-y-3">
          <h1 className="text-xl font-semibold text-red-700">OAuth 실패</h1>
          <p className="text-sm">error: {sp.error}</p>
        </main>
      </div>
    );
  }
  if (!sp.code) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-3xl mx-auto px-4 py-6">
          <p>No code present.</p>
        </main>
      </div>
    );
  }

  const h = await headers();
  // 가능하면 forwarded host/proto를 우선 (Vercel 뒤에 있을 때 안전)
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const redirectUri = `${proto}://${host}/oauth/google/callback`;

  const tokens = await exchangeCode(sp.code, redirectUri);

  if (tokens.error) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-3xl mx-auto px-4 py-6 space-y-3">
          <h1 className="text-xl font-semibold text-red-700">토큰 교환 실패</h1>
          <pre className="text-sm bg-zinc-50 dark:bg-zinc-900 p-3 rounded overflow-x-auto">
            {JSON.stringify(tokens, null, 2)}
          </pre>
        </main>
      </div>
    );
  }
  if (!tokens.refresh_token) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-3xl mx-auto px-4 py-6 space-y-3">
          <h1 className="text-xl font-semibold text-amber-700">refresh_token 없음</h1>
          <p className="text-sm">
            이미 동의한 적이 있어 refresh_token이 다시 발급되지 않았을 수 있습니다.
            <br />
            <a
              href="https://myaccount.google.com/permissions"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              myaccount.google.com/permissions
            </a>
            에서 본 앱(Jarvis) 액세스를 제거한 뒤 다시 시도하세요.
          </p>
          <pre className="text-xs bg-zinc-50 dark:bg-zinc-900 p-3 rounded overflow-x-auto">
            {JSON.stringify(tokens, null, 2)}
          </pre>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <h1 className="text-xl font-semibold text-emerald-700">OAuth 성공</h1>
        <p className="text-sm">
          아래 <code>refresh_token</code>을 Vercel 프로젝트의 환경변수
          <code className="mx-1 px-1 bg-zinc-100 dark:bg-zinc-800 rounded">GOOGLE_REFRESH_TOKEN</code>
          에 저장하세요. 한 번 저장하면 만료 전까지 영구 사용 가능합니다.
        </p>

        <details className="text-xs">
          <summary>Click to reveal refresh_token</summary>
          <pre className="mt-2 p-3 rounded bg-zinc-50 dark:bg-zinc-900 break-all whitespace-pre-wrap select-all">
            {tokens.refresh_token}
          </pre>
        </details>

        <p className="text-xs text-zinc-500">
          이 값은 누군가 가지면 본인 캘린더에 접근 가능합니다. 화면 캡처·로그·채팅에 노출되지
          않게 주의. 저장이 끝나면 이 페이지를 닫으세요.
        </p>

        <p className="text-xs text-zinc-500">
          참고: scope = <code>{tokens.scope ?? '—'}</code>, expires_in = {tokens.expires_in ?? '—'}s
        </p>
      </main>
    </div>
  );
}
