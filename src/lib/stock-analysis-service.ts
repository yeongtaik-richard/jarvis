import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockAnalysis, type StockAnalysis } from '@/db/schema';
import type { CreateStockAnalysisInput, StockAnalysisQuery } from './schemas';

export type ApiStockAnalysis = {
  id: string;
  created_at: string;
  symbol: string;
  kind: string;
  claim_type: string;
  title: string | null;
  body: string;
  input_snapshot_ids: string[];
  prompt_version: string | null;
  authored_by: string;
};

export function toApiStockAnalysis(r: StockAnalysis): ApiStockAnalysis {
  return {
    id: r.id,
    created_at: r.createdAt.toISOString(),
    symbol: r.symbol,
    kind: r.kind,
    claim_type: r.claimType,
    title: r.title,
    body: r.body,
    input_snapshot_ids: r.inputSnapshotIds,
    prompt_version: r.promptVersion,
    authored_by: r.authoredBy,
  };
}

export async function createStockAnalysis(
  input: CreateStockAnalysisInput,
): Promise<StockAnalysis> {
  const [row] = await db
    .insert(stockAnalysis)
    .values({
      symbol: input.symbol,
      kind: input.kind,
      claimType: input.claim_type,
      title: input.title ?? null,
      body: input.body,
      inputSnapshotIds: input.input_snapshot_ids,
      promptVersion: input.prompt_version ?? null,
      authoredBy: input.authored_by,
    })
    .returning();
  return row;
}

export async function searchStockAnalysis(
  query: StockAnalysisQuery,
): Promise<StockAnalysis[]> {
  const filters: SQL[] = [];
  if (query.symbol) filters.push(eq(stockAnalysis.symbol, query.symbol));
  if (query.kind) filters.push(eq(stockAnalysis.kind, query.kind));
  const whereExpr = filters.length ? and(...filters) : undefined;

  const base = db.select().from(stockAnalysis);
  const filtered = whereExpr ? base.where(whereExpr) : base;
  return filtered.orderBy(desc(stockAnalysis.createdAt)).limit(query.limit);
}
