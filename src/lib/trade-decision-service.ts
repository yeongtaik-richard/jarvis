import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { tradeDecisions, type TradeDecision } from '@/db/schema';
import { HttpError } from './errors';
import type {
  CreateTradeDecisionInput,
  PatchTradeDecisionInput,
  TradeDecisionQuery,
} from './schemas';

export type ApiTradeDecision = {
  id: string;
  symbol: string;
  decided_at: string;
  action: string;
  price: number | null;
  quantity: number | null;
  rationale: string;
  input_snapshot_ids: string[];
  analysis_id: string | null;
  status: string;
  outcome_at: string | null;
  outcome: string | null;
  lesson: string | null;
  created_at: string;
  updated_at: string;
};

export function toApiTradeDecision(d: TradeDecision): ApiTradeDecision {
  return {
    id: d.id,
    symbol: d.symbol,
    decided_at: d.decidedAt.toISOString(),
    action: d.action,
    price: d.price,
    quantity: d.quantity,
    rationale: d.rationale,
    input_snapshot_ids: d.inputSnapshotIds,
    analysis_id: d.analysisId,
    status: d.status,
    outcome_at: d.outcomeAt ? d.outcomeAt.toISOString() : null,
    outcome: d.outcome,
    lesson: d.lesson,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

export async function createTradeDecision(
  input: CreateTradeDecisionInput,
): Promise<TradeDecision> {
  const [row] = await db
    .insert(tradeDecisions)
    .values({
      symbol: input.symbol,
      // 지정 안 하면 DB now() — 결정 시각을 나중에 채우지 않는 게 이 로그의 요점이다.
      ...(input.decided_at ? { decidedAt: input.decided_at } : {}),
      action: input.action,
      price: input.price ?? null,
      quantity: input.quantity ?? null,
      rationale: input.rationale,
      inputSnapshotIds: input.input_snapshot_ids,
      analysisId: input.analysis_id ?? null,
    })
    .returning();
  return row;
}

export async function getTradeDecisionById(id: string): Promise<TradeDecision | null> {
  const [row] = await db
    .select()
    .from(tradeDecisions)
    .where(eq(tradeDecisions.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * 결과/교훈을 붙인다. outcome이나 lesson이 들어오면 outcome_at을 자동으로 찍고
 * (명시 값이 없을 때) 상태를 closed로 넘긴다 — 루프를 닫는 게 이 테이블의 목적.
 */
export async function patchTradeDecision(
  id: string,
  input: PatchTradeDecisionInput,
): Promise<TradeDecision> {
  const closing = input.outcome != null || input.lesson != null;
  const [row] = await db
    .update(tradeDecisions)
    .set({
      ...(input.status ? { status: input.status } : closing ? { status: 'closed' } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome ?? null } : {}),
      ...(input.lesson !== undefined ? { lesson: input.lesson ?? null } : {}),
      ...(input.outcome_at
        ? { outcomeAt: input.outcome_at }
        : closing
          ? { outcomeAt: sql`now()` }
          : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(tradeDecisions.id, id))
    .returning();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

export async function searchTradeDecisions(
  query: TradeDecisionQuery,
): Promise<TradeDecision[]> {
  const filters: SQL[] = [];
  if (query.symbol) filters.push(eq(tradeDecisions.symbol, query.symbol));
  if (query.status) filters.push(eq(tradeDecisions.status, query.status));
  if (query.action) filters.push(eq(tradeDecisions.action, query.action));
  const where = filters.length ? and(...filters) : undefined;

  const base = db.select().from(tradeDecisions);
  const filtered = where ? base.where(where) : base;
  return filtered.orderBy(desc(tradeDecisions.decidedAt)).limit(query.limit);
}
