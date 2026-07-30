import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  smallint,
  integer,
  doublePrecision,
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

export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: smallint('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    error: text('error'),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    index('ix_request_logs_ts').on(sql`ts desc`),
    index('ix_request_logs_status').on(t.status, sql`ts desc`),
    index('ix_request_logs_path').on(t.path, sql`ts desc`),
  ],
);

// Stock reference-info snapshots (트레이딩 참고정보 애그리게이터, PLAN-DASHBOARD §3).
// 수집기가 시간대별로 POST. bucketKey가 멱등 자연키(일별=YYYY-MM-DD, 인트라데이=ISO).
export const stockSnapshots = pgTable(
  'stock_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: text('symbol').notNull(),
    source: text('source').notNull(), // 'kis' | 'krx' | 'dart' | 'fake' ...
    metric: text('metric').notNull(), // 'investor_flow' | 'daily_ohlcv' | 'sox' ...
    bucketKey: text('bucket_key').notNull(), // 멱등 키: 일별 YYYY-MM-DD, 인트라데이 ISO
    schemaVersion: smallint('schema_version').notNull().default(1),
    tradingDateKst: text('trading_date_kst'), // 정보용 (KRX 거래일)
    asOfAt: timestamp('as_of_at', { withTimezone: true }), // 데이터 기준 시각
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    collectorRunId: uuid('collector_run_id'),
    payloadHash: text('payload_hash'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex('ux_stock_snapshot_natural').on(t.symbol, t.source, t.metric, t.bucketKey),
    index('ix_stock_snapshot_symbol_metric').on(t.symbol, t.metric, sql`captured_at desc`),
  ],
);

// AI briefings / opinions over the snapshots (PLAN-DASHBOARD §3, §12).
// claim_type/kind kept as text (enforced by zod at the API); body is the
// human-readable briefing. NO buy/sell/target/rating column by design (§12).
export const stockAnalysis = pgTable(
  'stock_analysis',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    symbol: text('symbol').notNull(),
    kind: text('kind').notNull().default('ondemand'), // pre | intraday | close | ondemand
    claimType: text('claim_type').notNull().default('state_summary'),
    title: text('title'),
    body: text('body').notNull(),
    inputSnapshotIds: uuid('input_snapshot_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    promptVersion: text('prompt_version'),
    authoredBy: text('authored_by').notNull().default('claude-session'),
  },
  (t) => [index('ix_stock_analysis_symbol_created').on(t.symbol, sql`created_at desc`)],
);

// Collector run log (운영 모니터링). id는 수집기가 만든 collector_run_id를 그대로 쓴다 —
// 스냅샷 행과 같은 값이라 "이 실행이 무엇을 남겼나"를 조인 없이 추적할 수 있다.
export const collectorRuns = pgTable(
  'collector_runs',
  {
    id: uuid('id').primaryKey(),
    symbol: text('symbol').notNull(),
    kind: text('kind').notNull().default('close'), // close | premarket | intraday | backfill | manual
    status: text('status').notNull().default('running'), // running | ok | partial | error
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    posted: integer('posted').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('ix_collector_runs_started').on(sql`started_at desc`),
    index('ix_collector_runs_status').on(t.status, sql`started_at desc`),
  ],
);

// 공시·뉴스 이벤트. 스냅샷과 달리 한 시점에 여러 건이 흐르므로 별도 테이블이다.
// 멱등키는 (source, external_id) — 공시 rcept_no, 뉴스 링크.
export const marketEvents = pgTable(
  'market_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: text('symbol').notNull(),
    source: text('source').notNull(), // dart | news
    externalId: text('external_id').notNull(),
    // DART 공시는 시각이 없어 09:00 KST 근사다 (src/lib/market-sources.ts 참고).
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    title: text('title').notNull(),
    url: text('url'),
    publisher: text('publisher'),
    category: text('category'),
    collectorRunId: uuid('collector_run_id'),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex('ux_market_events_natural').on(t.source, t.externalId),
    index('ix_market_events_symbol_published').on(t.symbol, sql`published_at desc`),
  ],
);

// 브리핑의 "지켜볼 것"을 기계 채점 가능한 조건으로 기록. 데이터가 오면 결정론적으로
// confirmed/refuted가 갈린다. 이 적중률이 validated_directional 해금의 전제조건.
export const stockPredictions = pgTable(
  'stock_predictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: text('symbol').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    analysisId: uuid('analysis_id').references(() => stockAnalysis.id),
    authoredBy: text('authored_by').notNull().default('claude-routine'),
    kind: text('kind').notNull().default('watch'), // watch | directional
    claim: text('claim').notNull(),
    metric: text('metric').notNull(),
    field: text('field').notNull(),
    comparator: text('comparator').notNull(), // gt | gte | lt | lte
    threshold: doublePrecision('threshold').notNull(),
    targetBucket: text('target_bucket').notNull(),
    status: text('status').notNull().default('pending'),
    actualValue: doublePrecision('actual_value'),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    scoreNote: text('score_note'),
  },
  (t) => [
    index('ix_stock_predictions_symbol_created').on(t.symbol, sql`created_at desc`),
    index('ix_stock_predictions_status').on(t.status, t.targetBucket),
  ],
);

// 결정 → 결과 → 교훈 루프. action의 buy/sell은 **사람이 한 결정의 기록**이지
// AI 추천이 아니다 (stock_analysis의 정직성 제약과 별개, docs/stock.md 참고).
export const tradeDecisions = pgTable(
  'trade_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: text('symbol').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    action: text('action').notNull(), // buy | sell | hold | watch | skip
    price: integer('price'),
    quantity: integer('quantity'),
    rationale: text('rationale').notNull(),
    inputSnapshotIds: uuid('input_snapshot_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    analysisId: uuid('analysis_id').references(() => stockAnalysis.id),
    status: text('status').notNull().default('open'), // open | closed
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
    outcome: text('outcome'),
    lesson: text('lesson'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_trade_decisions_symbol_decided').on(t.symbol, sql`decided_at desc`),
    index('ix_trade_decisions_status').on(t.status, sql`decided_at desc`),
  ],
);

export type EventThread = typeof eventThreads.$inferSelect;
export type EventVersion = typeof eventVersions.$inferSelect;
export type NewEventVersion = typeof eventVersions.$inferInsert;
export type ImprovementNote = typeof improvementNotes.$inferSelect;
export type NewImprovementNote = typeof improvementNotes.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type StockSnapshot = typeof stockSnapshots.$inferSelect;
export type NewStockSnapshot = typeof stockSnapshots.$inferInsert;
export type StockAnalysis = typeof stockAnalysis.$inferSelect;
export type NewStockAnalysis = typeof stockAnalysis.$inferInsert;
export type CollectorRun = typeof collectorRuns.$inferSelect;
export type NewCollectorRun = typeof collectorRuns.$inferInsert;
export type StockPrediction = typeof stockPredictions.$inferSelect;
export type NewStockPrediction = typeof stockPredictions.$inferInsert;
export type MarketEvent = typeof marketEvents.$inferSelect;
export type NewMarketEvent = typeof marketEvents.$inferInsert;
export type TradeDecision = typeof tradeDecisions.$inferSelect;
export type NewTradeDecision = typeof tradeDecisions.$inferInsert;
