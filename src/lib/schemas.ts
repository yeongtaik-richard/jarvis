import { z } from 'zod';

export const TimePrecision = z.enum(['exact', 'date', 'month', 'unknown']);
export type TimePrecision = z.infer<typeof TimePrecision>;

export const Source = z.enum(['gpt', 'web', 'sync']);
export const Kind = z.enum(['event', 'fact', 'relationship', 'trigger']);
export const Status = z.enum([
  'planned',
  'actual',
  'cancelled',
  'active',
  'resolved',
  'na',
]);
export const NoteStatus = z.enum(['open', 'triaged', 'applied', 'wontfix']);

// ISO 8601 with timezone offset required (e.g. 2026-05-05T15:00:00+09:00 or ...Z)
const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((v) => (v ? new Date(v) : null));

const tagsSchema = z.array(z.string().min(1).max(60)).max(20).default([]);

const attributesSchema = z
  .record(z.string(), z.unknown())
  .default(() => ({}));

// Strict boolean parser for query strings.
// `z.coerce.boolean()` follows JS Boolean(), so "false" → true. Don't use it.
const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

// MM-DD or M-D
const monthDay = z
  .string()
  .regex(/^(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])$/, 'expected MM-DD')
  .transform((v) => {
    const [m, d] = v.split('-').map((n) => parseInt(n, 10));
    return { month: m, day: d };
  });

export const CreateMemoryInput = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(8000).nullish(),
  kind: Kind.default('event'),
  status: Status.default('na'),
  start_time: isoDateTime,
  end_time: isoDateTime,
  actual_time: isoDateTime,
  timezone: z.string().max(64).nullish(),
  time_precision: TimePrecision.default('exact'),
  raw_time_text: z.string().max(200).nullish(),
  importance: z.number().int().min(0).max(2).default(0),
  tags: tagsSchema,
  attributes: attributesSchema,
  source: Source.default('gpt'),
  supersedes_id: z.string().uuid().nullish(),
});
export type CreateMemoryInput = z.infer<typeof CreateMemoryInput>;

// PATCH = supersede via existing version id (path param). supersedes_id는 URL이 결정.
export const PatchMemoryInput = CreateMemoryInput.omit({ supersedes_id: true });
export type PatchMemoryInput = z.infer<typeof PatchMemoryInput>;

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  tag: z.string().min(1).max(60).optional(),
  kind: Kind.optional(),
  status: Status.optional(),
  on_month_day: monthDay.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  include_history: queryBool.default(false),
  include_deleted: queryBool.default(false),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const TriggersDueQuery = z.object({
  date: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type TriggersDueQuery = z.infer<typeof TriggersDueQuery>;

export const CreateImprovementInput = z.object({
  observed_request: z.string().min(1).max(2000),
  missing_capability: z.string().min(1).max(2000),
  proposed_fix: z.string().max(4000).nullish(),
  priority: z.number().int().min(0).max(3).default(0),
  example_memory_id: z.string().uuid().nullish(),
});
export type CreateImprovementInput = z.infer<typeof CreateImprovementInput>;

export const PatchImprovementInput = z
  .object({
    status: NoteStatus,
    resolution_note: z.string().max(4000).nullish(),
    priority: z.number().int().min(0).max(3).optional(),
    proposed_fix: z.string().max(4000).nullish(),
  })
  .partial({ status: true });
export type PatchImprovementInput = z.infer<typeof PatchImprovementInput>;

export const ImprovementSearchQuery = z.object({
  status: NoteStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ImprovementSearchQuery = z.infer<typeof ImprovementSearchQuery>;

// Stock reference-info snapshots (aggregator). API fields are snake_case.
export const CreateStockSnapshotInput = z.object({
  symbol: z.string().min(1).max(20),
  source: z.string().min(1).max(20),
  metric: z.string().min(1).max(40),
  // 멱등 자연키: 일별 'YYYY-MM-DD', 인트라데이 ISO 버킷. 재수집 시 upsert 됨.
  bucket_key: z.string().min(1).max(60),
  schema_version: z.number().int().min(1).max(1000).default(1),
  trading_date_kst: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .nullish(),
  as_of_at: isoDateTime,
  collector_run_id: z.string().uuid().nullish(),
  payload: attributesSchema,
});
export type CreateStockSnapshotInput = z.infer<typeof CreateStockSnapshotInput>;

export const StockSnapshotQuery = z.object({
  symbol: z.string().min(1).max(20).optional(),
  metric: z.string().min(1).max(40).optional(),
  source: z.string().min(1).max(20).optional(),
  // latest=true → (symbol, metric)별 최신 1건만
  latest: queryBool.default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type StockSnapshotQuery = z.infer<typeof StockSnapshotQuery>;

// AI briefings / opinions. claim_type/kind enforced here (DB column is text).
export const StockAnalysisKind = z.enum(['pre', 'intraday', 'close', 'ondemand']);
export const StockClaimType = z.enum([
  'state_summary',
  'anomaly',
  'scenario',
  'risk',
  'validated_directional',
]);
export const CreateStockAnalysisInput = z
  .object({
    symbol: z.string().min(1).max(20).default('000660'),
    kind: StockAnalysisKind.default('ondemand'),
    claim_type: StockClaimType.default('state_summary'),
    title: z.string().max(200).nullish(),
    body: z.string().min(1).max(20000),
    input_snapshot_ids: z.array(z.string().uuid()).max(50).default([]),
    prompt_version: z.string().max(40).nullish(),
    authored_by: z.string().max(40).default('claude-session'),
  })
  // §12: directional claims require validation stats (not available until P4).
  .refine((v) => v.claim_type !== 'validated_directional', {
    message: 'validated_directional requires validation stats (P4)',
    path: ['claim_type'],
  });
export type CreateStockAnalysisInput = z.infer<typeof CreateStockAnalysisInput>;

export const StockAnalysisQuery = z.object({
  symbol: z.string().min(1).max(20).optional(),
  kind: StockAnalysisKind.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type StockAnalysisQuery = z.infer<typeof StockAnalysisQuery>;

// Collector runs — 수집기가 자기 실행을 보고한다 (운영 모니터링).
export const CollectorRunKind = z.enum(['close', 'premarket', 'intraday', 'backfill', 'manual']);
export const CollectorRunStatus = z.enum(['running', 'ok', 'partial', 'error']);
export const ReportCollectorRunInput = z.object({
  id: z.string().uuid(), // 스냅샷의 collector_run_id와 동일
  symbol: z.string().min(1).max(20),
  kind: CollectorRunKind.default('manual'),
  status: CollectorRunStatus.default('running'),
  finished: z.boolean().default(false),
  posted: z.number().int().min(0).max(100000).default(0),
  failed: z.number().int().min(0).max(100000).default(0),
  error: z.string().max(4000).nullish(),
});
export type ReportCollectorRunInput = z.infer<typeof ReportCollectorRunInput>;

export const CollectorRunQuery = z.object({
  symbol: z.string().min(1).max(20).optional(),
  status: CollectorRunStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CollectorRunQuery = z.infer<typeof CollectorRunQuery>;

// Market events — 공시·뉴스. (source, external_id)로 멱등 upsert.
export const MarketEventSource = z.enum(['dart', 'news']);
export const CreateMarketEventInput = z.object({
  symbol: z.string().min(1).max(20),
  source: MarketEventSource,
  external_id: z.string().min(1).max(200),
  published_at: z.string().datetime({ offset: true }).transform((v) => new Date(v)),
  title: z.string().min(1).max(500),
  url: z.string().max(2000).nullish(),
  publisher: z.string().max(120).nullish(),
  category: z.string().max(40).nullish(),
  collector_run_id: z.string().uuid().nullish(),
  raw: attributesSchema,
});
export type CreateMarketEventInput = z.infer<typeof CreateMarketEventInput>;

export const MarketEventQuery = z.object({
  symbol: z.string().min(1).max(20).optional(),
  source: MarketEventSource.optional(),
  // 이 시각 이후 발행분만 (장중 급변 구간 대조용)
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MarketEventQuery = z.infer<typeof MarketEventQuery>;

// Predictions — 반증 가능한 조건 + 자동 채점. 방향성 '주장'이 아니라 '검증 대상 기록'.
export const PredictionComparator = z.enum(['gt', 'gte', 'lt', 'lte']);
// 지평별로 레인을 나눠야 적중률이 섞이지 않는다 (stock-signal.ts HORIZONS 참고).
//   directional     = 5거래일 (역사적 이유로 접미사 없음)
//   directional_1d  = 1거래일
//   directional_h1  = 60분   ← 장중, 분봉으로 채점
//   directional_d0  = 당일 마감 ← 장중, 지금 가격 대비
export const PredictionKind = z.enum([
  'watch',
  'directional',
  'directional_1d',
  'directional_h1',
  'directional_d0',
  'directional_pm_open',  // 프리마켓 → 당일 시가
  'directional_pm_close', // 프리마켓 → 당일 종가 (18:43 레인과 같은 대상)
]);
export const PredictionStatus = z.enum([
  'pending',
  'confirmed',
  'refuted',
  'expired',
  'unverifiable',
]);
export const CreatePredictionInput = z.object({
  symbol: z.string().min(1).max(20).default('000660'),
  analysis_id: z.string().uuid().nullish(),
  authored_by: z.string().max(40).default('claude-routine'),
  kind: PredictionKind.default('watch'),
  claim: z.string().min(1).max(500),
  metric: z.string().min(1).max(40),
  field: z.string().min(1).max(60),
  comparator: PredictionComparator,
  threshold: z.number().finite(),
  // 채점 대상 bucket_key. 일별 YYYY-MM-DD 또는 인트라데이 ISO.
  target_bucket: z.string().min(10).max(60),
  /**
   * 판정 시점의 규칙 상태를 박제한다 (규칙 신호 레인에서만 채운다):
   * { score, passed, gated, applied_threshold, volatility, components }.
   * passed=false는 게이트에 막힌 날 — 매매 참고가 아니라 게이트 검증용 표본이다.
   */
  context: z.record(z.string(), z.unknown()).nullish(),
});
export type CreatePredictionInput = z.infer<typeof CreatePredictionInput>;

export const PredictionQuery = z.object({
  symbol: z.string().min(1).max(20).optional(),
  status: PredictionStatus.optional(),
  authored_by: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PredictionQuery = z.infer<typeof PredictionQuery>;

// Trade decisions — 사람이 실제로 한 결정의 기록. AI 추천이 아니다.
export const TradeAction = z.enum(['buy', 'sell', 'hold', 'watch', 'skip']);
export const TradeDecisionStatus = z.enum(['open', 'closed']);
export const CreateTradeDecisionInput = z.object({
  symbol: z.string().min(1).max(20).default('000660'),
  decided_at: isoDateTime,
  action: TradeAction,
  price: z.number().int().min(0).max(100_000_000).nullish(),
  quantity: z.number().int().min(0).max(10_000_000).nullish(),
  rationale: z.string().min(1).max(4000),
  input_snapshot_ids: z.array(z.string().uuid()).max(50).default([]),
  analysis_id: z.string().uuid().nullish(),
});
export type CreateTradeDecisionInput = z.infer<typeof CreateTradeDecisionInput>;

export const PatchTradeDecisionInput = z
  .object({
    status: TradeDecisionStatus.optional(),
    outcome: z.string().max(4000).nullish(),
    lesson: z.string().max(4000).nullish(),
    outcome_at: isoDateTime,
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.outcome !== undefined ||
      v.lesson !== undefined ||
      v.outcome_at !== null,
    { message: 'nothing to update' },
  );
export type PatchTradeDecisionInput = z.infer<typeof PatchTradeDecisionInput>;

export const TradeDecisionQuery = z.object({
  symbol: z.string().min(1).max(20).optional(),
  status: TradeDecisionStatus.optional(),
  action: TradeAction.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TradeDecisionQuery = z.infer<typeof TradeDecisionQuery>;
