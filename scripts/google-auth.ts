// 일회성 Google OAuth 동의 → refresh_token 획득 스크립트.
// 사용법: pnpm google:auth (.env.local에 GOOGLE_CLIENT_ID/SECRET 먼저 채워둘 것)
//
// 동작:
// 1. 인증 URL을 브라우저로 연다 (offline + force consent → refresh_token 보장)
// 2. localhost:8765 에서 콜백 대기
// 3. code 받아 토큰 교환 (POST oauth2.googleapis.com/token)
// 4. refresh_token 출력. .env.local + Vercel env에 GOOGLE_REFRESH_TOKEN으로 저장

import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/oauth/callback`;
const SCOPE = 'https://www.googleapis.com/auth/calendar';

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Missing env. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local first.');
    process.exit(1);
  }

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');

  console.log('\nOpening browser for consent. If it does not open, paste this URL:');
  console.log('\n  ' + authUrl.toString() + '\n');

  // macOS open
  exec(`open "${authUrl.toString()}"`, () => {});

  const code = await waitForCallback();

  console.log('Got code, exchanging for tokens...');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (tokens.error) {
    console.error('Token exchange failed:', tokens);
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    console.error(
      'No refresh_token returned. Possible cause: Google does not re-issue refresh_token if you previously consented.\n' +
        'Fix: revoke the app at https://myaccount.google.com/permissions and run this script again.\n' +
        'Response:',
      tokens,
    );
    process.exit(1);
  }

  console.log('\n=== SUCCESS ===\n');
  console.log('refresh_token:\n  ' + tokens.refresh_token + '\n');
  console.log('Add to .env.local and Vercel project env:');
  console.log(`  GOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"`);
  console.log('\nVerify it works:');
  console.log('  curl -X POST https://oauth2.googleapis.com/token \\');
  console.log('    -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET" \\');
  console.log(`    -d "refresh_token=${tokens.refresh_token}&grant_type=refresh_token"`);
}

function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${err}</p>`);
        server.close();
        reject(new Error(err));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('No code in callback');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>OK</h1><p>refresh_token 획득 성공. 터미널을 보세요. 이 창은 닫아도 됩니다.</p>');
      server.close();
      resolve(code);
    });
    server.listen(PORT, () => {
      console.log(`Callback server listening on http://localhost:${PORT}`);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
