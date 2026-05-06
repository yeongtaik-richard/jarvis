import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  smallint,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const syncStateEnum = pgEnum('sync_state', ['pending', 'synced', 'error']);
export const opEnum = pgEnum('op', ['create', 'update', 'delete']);
export const timePrecisionEnum = pgEnum('time_precision', ['exact', 'date', 'month', 'unknown']);
export const sourceEnum = pgEnum('source', ['gpt', 'web', 'sync']);
export const kindEnum = pgEnum('kind', ['event', 'fact', 'relationship', 'trigger']);
export const statusEnum = pgEnum('status', [
  'planned',
  'actual',
  'cancelled',
  'active',
  'resolved',
  'na',
]);
export const noteStatusEnum = pgEnum('note_status', ['open', 'triaged', 'applied', 'wontfix']);

export const eventThreads = pgTable('event_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  currentVersionId: uuid('current_version_id'),
  googleEventId: text('google_event_id'),
  googleEtag: text('google_etag'),
  syncState: syncStateEnum('sync_state').notNull().default('pending'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventVersions = pgTable(
  'event_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => eventThreads.id),
    supersedesId: uuid('supersedes_id'),
    isCanonical: boolean('is_canonical').notNull().default(false),
    op: opEnum('op').notNull(),
    kind: kindEnum('kind').notNull().default('event'),
    status: statusEnum('status').notNull().default('na'),
    title: text('title').notNull(),
    body: text('body'),
    // event_time: 0001 호환용. 새 코드는 startTime/endTime/actualTime을 사용한다.
    eventTime: timestamp('event_time', { withTimezone: true }),
    startTime: timestamp('start_time', { withTimezone: true }),
    endTime: timestamp('end_time', { withTimezone: true }),
    actualTime: timestamp('actual_time', { withTimezone: true }),
    timezone: text('timezone'),
    timePrecision: timePrecisionEnum('time_precision').notNull().default('exact'),
    rawTimeText: text('raw_time_text'),
    importance: smallint('importance').notNull().default(0),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),
    source: sourceEnum('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    searchTsv: text('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))`,
    ),
  },
  (t) => [
    uniqueIndex('ux_canonical_per_thread').on(t.threadId).where(sql`is_canonical`),
    index('ix_versions_event_time').on(sql`event_time desc nulls last`),
    index('ix_versions_created_at').on(sql`created_at desc`),
    index('ix_versions_thread').on(t.threadId),
    index('ix_versions_search').using('gin', sql`search_tsv`),
    index('ix_versions_tags').using('gin', t.tags),
    index('ix_versions_kind_status').on(t.kind, t.status),
    index('ix_versions_start_time').on(sql`start_time desc nulls last`),
    index('ix_versions_actual_time').on(sql`actual_time desc nulls last`),
    index('ix_versions_attributes').using('gin', t.attributes),
  ],
);

export const improvementNotes = pgTable(
  'improvement_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    observedRequest: text('observed_request').notNull(),
    missingCapability: text('missing_capability').notNull(),
    proposedFix: text('proposed_fix'),
    priority: smallint('priority').notNull().default(0),
    status: noteStatusEnum('status').notNull().default('open'),
    exampleMemoryId: uuid('example_memory_id').references(() => eventVersions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
  },
  (t) => [
    index('ix_improvement_status').on(t.status, sql`created_at desc`),
  ],
);

export type EventThread = typeof eventThreads.$inferSelect;
export type EventVersion = typeof eventVersions.$inferSelect;
export type NewEventVersion = typeof eventVersions.$inferInsert;
export type ImprovementNote = typeof improvementNotes.$inferSelect;
export type NewImprovementNote = typeof improvementNotes.$inferInsert;
