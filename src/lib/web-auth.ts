import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, sessionHash } from './auth-shared';

async function expectedHash(): Promise<string | null> {
  const pw = process.env.JARVIS_WEB_PASSWORD;
  if (!pw) return null;
  return sessionHash(pw);
}

export async function isLoggedIn(): Promise<boolean> {
  const expected = await expectedHash();
  if (!expected) return false;
  const c = await cookies();
  return c.get(SESSION_COOKIE)?.value === expected;
}

export async function requireSession(): Promise<void> {
  if (!(await isLoggedIn())) {
    redirect('/login');
  }
}

export async function signIn(password: string): Promise<boolean> {
  const target = process.env.JARVIS_WEB_PASSWORD;
  if (!target || password !== target) return false;
  const c = await cookies();
  c.set(SESSION_COOKIE, await sessionHash(target), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30일
  });
  return true;
}

export async function signOut(): Promise<void> {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
}
