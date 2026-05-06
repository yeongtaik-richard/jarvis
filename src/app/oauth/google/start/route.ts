import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 미들웨어가 세션 쿠키 없으면 /login으로 보내므로 별도 인증 처리 불필요.
export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new NextResponse('GOOGLE_CLIENT_ID not set', { status: 500 });
  }
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/oauth/google/callback`;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');

  return NextResponse.redirect(url.toString());
}
