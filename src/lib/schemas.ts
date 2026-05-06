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
