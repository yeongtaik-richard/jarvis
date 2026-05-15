import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { jsonError, ok } from '@/lib/http';
import { listFailedThreads, resyncFailedThreads } from '@/lib/calendar-sync';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 동기화는 모든 실패 thread를 차례로 재시도하므로 길게 걸릴 수 있음.
export const maxDuration = 60;

export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;
  try {
    const rows = await listFailedThreads();
    return ok({
      count: rows.length,
      items: rows.map((r) => ({
        thread_id: r.id,
        sync_state: r.syncState,
        google_event_id: r.googleEventId,
        last_synced_at: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
      })),
    });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;
  try {
    const result = await resyncFailedThreads();
    return ok(result);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
