import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { eventThreads, eventVersions, type EventVersion } from '@/db/schema';
import { HttpError } from './errors';
import type {
  CreateMemoryInput,
  SearchQuery,
  TriggersDueQuery,
} from './schemas';

export type ApiMemory = {
  id: string;
  thread_id: string;
  supersedes_id: string | null;
  is_canonical: boolean;
  op: 'create' | 'update' | 'delete';
  kind: 'event' | 'fact' | 'relationship' | 'trigger';
  status: 'planned' | 'actual' | 'cancelled' | 'active' | 'resolved' | 'na';
  title: string;
  body: string | null;
  start_time: string | null;
  end_time: string | null;
  actual_time: string | null;
  timezone: string | null;
  time_precision: 'exact' | 'date' | 'month' | 'unknown';
  raw_time_text: string | null;
  importance: number;
  tags: string[];
  attributes: Record<string, unknown>;
  source: 'gpt' | 'web' | 'sync';
  created_at: string;
  deleted_at: string | null;
};

export function toApiMemory(v: EventVersion): ApiMemory {
  return {
    id: v.id,
    thread_id: v.threadId,
    supersedes_id: v.supersedesId,
    is_canonical: v.isCanonical,
    op: v.op,
    kind: v.kind,
    status: v.status,
    title: v.title,
    body: v.body,
    start_time: v.startTime ? v.startTime.toISOString() : null,
    end_time: v.endTime ? v.endTime.toISOString() : null,
    actual_time: v.actualTime ? v.actualTime.toISOString() : null,
    timezone: v.timezone,
    time_precision: v.timePrecision,
    raw_time_text: v.rawTimeText,
    importance: v.importance,
    tags: v.tags,
    attributes: (v.attributes as Record<string, unknown>) ?? {},
    source: v.source,
    created_at: v.createdAt.toISOString(),
    deleted_at: v.deletedAt ? v.deletedAt.toISOString() : null,
  };
}

type WriteInput = Omit<CreateMemoryInput, 'supersedes_id'> & { supersedes_id?: string | null };

export async function createOrSupersede(input: WriteInput): Promise<EventVersion> {
  return db.transaction(async (tx) => {
    let threadId: string;
    let supersedesId: string | null = null;
    let opVal: 'create' | 'update' = 'create';

    if (input.supersedes_id) {
      const [old] = await tx
        .update(eventVersions)
        .set({ isCanonical: false })
        .where(
          and(
            eq(eventVersions.id, input.supersedes_id),
            eq(eventVersions.isCanonical, true),
          ),
        )
        .returning({ threadId: eventVersions.threadId });
      if (!old) {
        throw new HttpError(409, 'not_canonical_or_missing');
      }
      threadId = old.threadId;
      supersedesId = input.supersedes_id;
      opVal = 'update';
    } else {
      const [thread] = await tx
        .insert(eventThreads)
        .values({})
        .returning({ id: eventThreads.id });
      threadId = thread.id;
    }

    const [created] = await tx
      .insert(eventVersions)
      .values({
        threadId,
        supersedesId,
        isCanonical: true,
        op: opVal,
        kind: input.kind,
        status: input.status,
        title: input.title,
        body: input.body ?? null,
        startTime: input.start_time,
        endTime: input.end_time,
        actualTime: input.actual_time,
        timezone: input.timezone ?? null,
        timePrecision: input.time_precision,
        rawTimeText: input.raw_time_text ?? null,
        importance: input.importance,
        tags: input.tags,
        attributes: input.attributes,
        source: input.source,
      })
      .returning();

    await tx
      .update(eventThreads)
      .set({ currentVersionId: created.id })
      .where(eq(eventThreads.id, threadId));

    return created;
  });
}

export async function softDelete(id: string): Promise<EventVersion> {
  return db.transaction(async (tx) => {
    const [old] = await tx
      .update(eventVersions)
      .set({ isCanonical: false })
      .where(
        and(
          eq(eventVersions.id, id),
          eq(eventVersions.isCanonical, true),
        ),
      )
      .returning();
    if (!old) {
      throw new HttpError(409, 'not_canonical_or_missing');
    }
    if (old.op === 'delete' || old.deletedAt !== null) {
      throw new HttpError(409, 'already_deleted');
    }

    const [tombstone] = await tx
      .insert(eventVersions)
      .values({
        threadId: old.threadId,
        supersedesId: old.id,
        isCanonical: true,
        op: 'delete',
        kind: old.kind,
        status: old.status,
        title: old.title,
        body: old.body,
        startTime: old.startTime,
        endTime: old.endTime,
        actualTime: old.actualTime,
        timezone: old.timezone,
        timePrecision: old.timePrecision,
        rawTimeText: old.rawTimeText,
        importance: old.importance,
        tags: old.tags,
        attributes: old.attributes,
        source: old.source,
        deletedAt: new Date(),
      })
      .returning();

    await tx
      .update(eventThreads)
      .set({ currentVersionId: tombstone.id })
      .where(eq(eventThreads.id, old.threadId));

    return tombstone;
  });
}

export async function getById(id: string): Promise<EventVersion | null> {
  const [row] = await db.select().from(eventVersions).where(eq(eventVersions.id, id)).limit(1);
  return row ?? null;
}

export async function getThreadHistory(threadId: string): Promise<EventVersion[]> {
  return db
    .select()
    .from(eventVersions)
    .where(eq(eventVersions.threadId, threadId))
    .orderBy(desc(eventVersions.createdAt));
}

// 정렬 키: actual_time(실제 발생) → start_time(계획/시작) → event_time(legacy) → created_at
const sortTimeExpr = sql`coalesce(
  ${eventVersions.actualTime},
  ${eventVersions.startTime},
  ${eventVersions.eventTime},
  ${eventVersions.createdAt}
)`;

export async function search(query: SearchQuery): Promise<EventVersion[]> {
  const filters: SQL[] = [];

  if (!query.include_history) {
    filters.push(sql`${eventVersions.isCanonical} = true`);
  }
  if (!query.include_deleted) {
    // 명시적 삭제(tombstone)가 있는 thread 전체를 제외.
    // status='cancelled' 같은 계획 변경은 영향 없음.
    filters.push(
      sql`${eventVersions.threadId} not in (
        select thread_id from event_versions where deleted_at is not null
      )`,
    );
  }
  if (query.q) {
    filters.push(
      sql`(${eventVersions.searchTsv} @@ plainto_tsquery('simple', ${query.q})
            or ${eventVersions.title} ilike ${`%${query.q}%`}
            or coalesce(${eventVersions.body}, '') ilike ${`%${query.q}%`})`,
    );
  }
  if (query.from) {
    filters.push(sql`${sortTimeExpr} >= ${query.from}`);
  }
  if (query.to) {
    filters.push(sql`${sortTimeExpr} <= ${query.to}`);
  }
  if (query.tag) {
    filters.push(sql`${query.tag} = ANY(${eventVersions.tags})`);
  }
  if (query.kind) {
    filters.push(sql`${eventVersions.kind} = ${query.kind}`);
  }
  if (query.status) {
    filters.push(sql`${eventVersions.status} = ${query.status}`);
  }
  if (query.on_month_day) {
    const { month, day } = query.on_month_day;
    filters.push(
      sql`(extract(month from ${eventVersions.startTime})::int = ${month}
           and extract(day   from ${eventVersions.startTime})::int = ${day})`,
    );
  }

  const whereExpr = filters.length ? sql.join(filters, sql` and `) : sql`true`;

  // Default search (canonical+alive 만): time 보유 그룹을 위로.
  // include_history: canonical을 위로(현재 상태 우선), 그 안에서 시간순.
  const orderBy = query.include_history
    ? [
        desc(eventVersions.isCanonical),
        desc(eventVersions.importance),
        sql`${sortTimeExpr} desc`,
        desc(eventVersions.createdAt),
      ]
    : [
        sql`case when ${sortTimeExpr} is not null then 0 else 1 end`,
        desc(eventVersions.importance),
        sql`${sortTimeExpr} desc`,
        desc(eventVersions.createdAt),
      ];

  return db
    .select()
    .from(eventVersions)
    .where(whereExpr)
    .orderBy(...orderBy)
    .limit(query.limit);
}

// 주어진 날짜에 트리거 되어야 할 메모(생일·기념일 등) 조회.
// kind='trigger', status='active' (and not deleted/canonical) 중,
// attributes.recur_yearly === true → start_time의 month-day 매칭
// 그 외 → start_time::date 정확 매칭
//
// 모든 비교는 row의 timezone 칼럼(없으면 DEFAULT_TZ)을 기준으로 한다.
// 한국 사용자가 KST 자정에 등록한 9-28을 9-28로 매칭하기 위함.
const DEFAULT_TZ = 'Asia/Seoul';

function calendarPartsIn(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
  };
}

export async function getTriggersDue(query: TriggersDueQuery): Promise<EventVersion[]> {
  const target = query.date ?? new Date();
  const { isoDate, month, day } = calendarPartsIn(target, DEFAULT_TZ);
  const tz = sql`coalesce(${eventVersions.timezone}, ${DEFAULT_TZ})`;
  const localStart = sql`(${eventVersions.startTime} at time zone ${tz})`;

  return db
    .select()
    .from(eventVersions)
    .where(
      sql`${eventVersions.isCanonical} = true
          and ${eventVersions.deletedAt} is null
          and ${eventVersions.kind} = 'trigger'
          and ${eventVersions.status} = 'active'
          and ${eventVersions.startTime} is not null
          and (
            (${eventVersions.attributes} ->> 'recur_yearly' = 'true'
              and extract(month from ${localStart})::int = ${month}
              and extract(day   from ${localStart})::int = ${day})
            or
            (coalesce(${eventVersions.attributes} ->> 'recur_yearly', 'false') <> 'true'
              and ${localStart}::date = ${isoDate}::date)
          )`,
    )
    .orderBy(desc(eventVersions.importance), desc(eventVersions.createdAt))
    .limit(query.limit);
}
