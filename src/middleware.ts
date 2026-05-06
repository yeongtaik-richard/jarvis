import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionHash } from '@/lib/auth-shared';

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // API는 Bearer로 자체 인증
  if (path.startsWith('/api/')) return NextResponse.next();
  // 로그인 페이지·정적 자산은 통과
  if (path === '/login' || path.startsWith('/_next/') || path === '/favicon.ico') {
    return NextResponse.next();
  }

  const pw = process.env.JARVIS_WEB_PASSWORD;
  if (!pw) {
    // 비번 미설정이면 로그인 자체가 불가 → 로그인 페이지로 보냄(거기서 안내)
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const expected = await sessionHash(pw);
  const got = req.cookies.get(SESSION_COOKIE)?.value;
  if (got === expected) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  if (path !== '/') url.searchParams.set('returnTo', path);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|openapi.yaml).*)',
};
