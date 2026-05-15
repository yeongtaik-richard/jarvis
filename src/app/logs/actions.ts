'use server';

import { lt, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { requestLogs } from '@/db/schema';

export async function pruneOldLogsAction(): Promise<void> {
  const cutoff = sql`now() - interval '30 days'`;
  await db.delete(requestLogs).where(lt(requestLogs.ts, cutoff));
  revalidatePath('/logs');
}
