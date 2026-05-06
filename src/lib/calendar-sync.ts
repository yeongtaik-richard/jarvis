// 메모리 thread를 Google Calendar 이벤트와 동기화한다.
// 정책:
// - sync 대상은 kind='event' AND start_time IS NOT NULL 만.
// - canonical version 기준으로 캘린더 이벤트의 내용을 결정.
// - 첫 동기화: events.insert → google_event_id 저장.
// - 재동기화: google_event_id 있으면 events.patch.
// - tombstone(op=delete) 또는 status=cancelled: events.delete.
// - kind!='event' 이거나 start_time 없으면 skip (이미 캘린더에 있으면 삭제).
//
// 실패 시: improvement_notes에 기록 + event_threads.sync_state='error'.

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  eventThreads,
  eventVersions,
  improvementNotes,
  type EventVersion,
} from '@/db/schema';
import {
  deleteEvent,
  insertEvent,
  patchEvent,
  type CalendarEventInput,
} from './google-calendar';

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ||
  process.env.VERCEL_URL ||
  'https://jarvis-yeongtaik.vercel.app';

function siteUrl(path: string) {
  const base = PUBLIC_BASE_URL.startsWith('http') ? PUBLIC_BASE_URL : `https://${PUBLIC_BASE_URL}`;
  return `${base}${path}`;
}

function shouldHaveCalendarEvent(v: EventVersion): boolean {
  if (v.deletedAt !== null) return false;
  if (v.op === 'delete') return false;
  if (v.status === 'cancelled') return false;
  if (v.kind !== 'event') return false;
  if (!v.startTime) return false;
  return true;
}

function buildEventBody(v: EventVersion): CalendarEventInput {
  const tz = v.timezone || 'Asia/Seoul';
  const allDay = v.timePrecision === 'date';
  const startISO = v.startTime!.toISOString();
  const endRaw = v.endTime ?? v.actualTime ?? null;
  // end_time이 없으면 1시간짜리 점 이벤트로.
  const endISO = endRaw
    ? endRaw.toISOString()
    : new Date(v.startTime!.getTime() + 60 * 60 * 1000).toISOString();

  const start = allDay
    ? { date: startISO.slice(0, 10), timeZone: tz }
    : { dateTime: startISO, timeZone: tz };
  const end = allDay
    ? { date: endISO.slice(0, 10), timeZone: tz }
    : { dateTime: endISO, timeZone: tz };

  // attributes에서 location 후보를 뽑는다 (location > hotel > place).
  const a = (v.attributes as Record<string, unknown>) ?? {};
  const location =
    typeof a.location === 'string'
      ? a.location
      : typeof a.hotel === 'string'
        ? a.hotel
        : typeof a.place === 'string'
          ? a.place
          : null;

  const desc =
    (v.body ? v.body + '\n\n' : '') +
    `Jarvis: ${siteUrl(`/m/${v.id}`)}\n` +
    `version_id: ${v.id}\nthread_id: ${v.threadId}`;

  return {
    summary: v.title,
    description: desc,
    location: location ?? undefined,
    start,
    end,
    extendedProperties: {
      private: { thread_id: v.threadId, version_id: v.id, jarvis: '1' },
    },
    source: { title: 'Jarvis', url: siteUrl(`/m/${v.id}`) },
  };
}

async function logSyncFailure(v: EventVersion, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await db.insert(improvementNotes).values({
      observedRequest: `Calendar sync failed for "${v.title}" (thread ${v.threadId})`,
      missingCapability: message,
      proposedFix:
        `POST /api/calendar/resync 호출하면 재시도됨. ` +
        `또는 에러 메시지를 보고 OAuth/네트워크 문제를 직접 해결.`,
      priority: 1,
      exampleMemoryId: v.id,
    });
  } catch (logErr) {
    // improvement note 기록도 실패하면 콘솔에만 남긴다.
    console.error('failed to log sync failure', logErr);
  }
}

async function markThreadError(threadId: string) {
  await db
    .update(eventThreads)
    .set({ syncState: 'error', lastSyncedAt: new Date() })
    .where(eq(eventThreads.id, threadId));
}

async function markThreadSynced(threadId: string, googleEventId: string | null) {
  await db
    .update(eventThreads)
    .set({
      syncState: 'synced',
      lastSyncedAt: new Date(),
      googleEventId,
    })
    .where(eq(eventThreads.id, threadId));
}

// thread의 현재 canonical version에 맞춰 캘린더를 동기화.
// 호출 시점: 메모리 write 직후 after()에서 한 번. 또는 manual resync에서 반복 호출.
export async function syncThreadToCalendar(threadId: string): Promise<void> {
  const [thread] = await db
    .select()
    .from(eventThreads)
    .where(eq(eventThreads.id, threadId))
    .limit(1);
  if (!thread) return;

  const [current] = await db
    .select()
    .from(eventVersions)
    .where(sql`${eventVersions.threadId} = ${threadId} and ${eventVersions.isCanonical} = true`)
    .limit(1);
  if (!current) return;

  const existingId = thread.googleEventId;

  try {
    if (!shouldHaveCalendarEvent(current)) {
      // 이미 캘린더에 있으면 삭제, 없으면 no-op.
      if (existingId) {
        await deleteEvent(existingId);
        await markThreadSynced(threadId, null);
      } else {
        await markThreadSynced(threadId, null);
      }
      return;
    }

    const body = buildEventBody(current);
    if (existingId) {
      const updated = await patchEvent(existingId, body);
      await markThreadSynced(threadId, updated.id ?? existingId);
    } else {
      const created = await insertEvent(body);
      await markThreadSynced(threadId, created.id);
    }
  } catch (err) {
    console.error('calendar sync failed', err);
    await Promise.allSettled([logSyncFailure(current, err), markThreadError(threadId)]);
  }
}

export type ResyncResult = {
  attempted: number;
  synced: number;
  failed: number;
  thread_ids: { thread_id: string; google_event_id: string | null; sync_state: string }[];
};

// pending/error 상태인 모든 thread를 재동기화. improvement_notes 자동 처리는 안 함
// (성공해도 노트는 그대로 남김 — 사용자가 검토 후 직접 status=applied로 바꿈).
export async function resyncFailedThreads(): Promise<ResyncResult> {
  const pending = await db
    .select({ id: eventThreads.id })
    .from(eventThreads)
    .where(sql`${eventThreads.syncState} in ('pending', 'error')`);

  let synced = 0;
  let failed = 0;
  for (const { id } of pending) {
    await syncThreadToCalendar(id);
    const [after] = await db
      .select({ syncState: eventThreads.syncState })
      .from(eventThreads)
      .where(eq(eventThreads.id, id))
      .limit(1);
    if (after?.syncState === 'synced') synced += 1;
    else failed += 1;
  }

  const after = await db
    .select({
      thread_id: eventThreads.id,
      google_event_id: eventThreads.googleEventId,
      sync_state: eventThreads.syncState,
    })
    .from(eventThreads)
    .where(sql`${eventThreads.id} = ANY(${pending.map((p) => p.id)})`);

  return {
    attempted: pending.length,
    synced,
    failed,
    thread_ids: after,
  };
}

export async function listFailedThreads() {
  return db
    .select()
    .from(eventThreads)
    .where(sql`${eventThreads.syncState} in ('pending', 'error')`);
}
