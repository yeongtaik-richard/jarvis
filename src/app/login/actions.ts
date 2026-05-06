'use server';

import { redirect } from 'next/navigation';
import { signIn, signOut } from '@/lib/web-auth';

export async function loginAction(formData: FormData) {
  const password = String(formData.get('password') ?? '');
  const returnTo = String(formData.get('returnTo') ?? '/');
  const ok = await signIn(password);
  if (!ok) {
    redirect('/login?error=invalid' + (returnTo !== '/' ? `&returnTo=${encodeURIComponent(returnTo)}` : ''));
  }
  redirect(returnTo);
}

export async function logoutAction() {
  await signOut();
  redirect('/login');
}
