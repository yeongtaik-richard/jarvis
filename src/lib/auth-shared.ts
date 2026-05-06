// Edge runtime(middleware) + Node runtime(routes/RSC) 모두에서 동일하게 동작하는
// 세션 해시 함수. Web Crypto API만 사용한다.

const SESSION_SALT = 'jarvis-session-v1';

export async function sessionHash(password: string): Promise<string> {
  const enc = new TextEncoder().encode(password + '|' + SESSION_SALT);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const SESSION_COOKIE = 'jarvis_session';
