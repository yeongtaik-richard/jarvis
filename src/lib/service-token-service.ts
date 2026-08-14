/**
 * 서비스 토큰 캐시의 서버 쪽. **여기서는 복호화하지 않는다** — 서버는 열 수 없는
 * 덩어리를 보관만 한다. 키는 수집기(KIS_APP_SECRET)에만 있다.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { serviceTokens } from '@/db/schema';

export type CachedServiceToken = {
  ciphertext: string;
  key_fingerprint: string;
  expires_at: string;
  updated_at: string;
};

export async function getServiceToken(name: string): Promise<CachedServiceToken | null> {
  const [row] = await db.select().from(serviceTokens).where(eq(serviceTokens.name, name)).limit(1);
  if (!row) return null;
  return {
    ciphertext: row.ciphertext,
    key_fingerprint: row.keyFingerprint,
    expires_at: row.expiresAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function putServiceToken(input: {
  name: string;
  ciphertext: string;
  key_fingerprint: string;
  expires_at: string;
}): Promise<void> {
  const values = {
    name: input.name,
    ciphertext: input.ciphertext,
    keyFingerprint: input.key_fingerprint,
    expiresAt: new Date(input.expires_at),
    updatedAt: new Date(),
  };
  await db
    .insert(serviceTokens)
    .values(values)
    .onConflictDoUpdate({ target: serviceTokens.name, set: values });
}
