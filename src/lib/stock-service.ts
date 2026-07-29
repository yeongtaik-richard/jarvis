import { createHash } from 'node:crypto';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockSnapshots, type StockSnapshot } from '@/db/schema';
import type { CreateStockSnapshotInput, StockSnapshotQuery } from './schemas';

export type ApiStockSnapshot = {
  id: string;
  symbol: string;
  source: string;
  metric: string;
  bucket_key: string;
  schema_version: number;
  trading_date_kst: string | null;
  as_of_at: string | null;
  captured_at: string;
  collector_run_id: string | null;
  payload_hash: string | null;
  payload: unknown;
};

export function toApiStockSnapshot(r: StockSnapshot): ApiStockSnapshot {
  return {
    id: r.id,
    symbol: r.symbol,
    source: r.source,
    metric: r.metric,
    bucket_key: r.bucketKey,
    schema_version: r.schemaVersion,
    trading_date_kst: r.tradingDateKst,
    as_of_at: r.asOfAt ? r.asOfAt.toISOString() : null,
    captured_at: r.capturedAt.toISOString(),
    collector_run_id: r.collectorRunId,
    payload_hash: r.payloadHash,
    payload: r.payload,
  };
}

/**
 * Upsert a snapshot by its natural key (symbol, source, metric, bucket_key).
 * Re-collecting the same bucket overwrites it — collector retries are idempotent.
 */
export async function upsertStockSnapshot(
  input: CreateStockSnapshotInput,
): Promise<StockSnapshot> {
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(input.payload))
    .digest('hex');

  const values = {
    symbol: input.symbol,
    source: input.source,
    metric: input.metric,
    bucketKey: input.bucket_key,
    schemaVersion: input.schema_version,
    tradingDateKst: input.trading_date_kst ?? null,
    asOfAt: input.as_of_at ?? null,
    collectorRunId: input.collector_run_id ?? null,
    payloadHash,
    payload: input.payload,
  };

  const [row] = await db
    .insert(stockSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [
        stockSnapshots.symbol,
        stockSnapshots.source,
        stockSnapshots.metric,
        stockSnapshots.bucketKey,
      ],
      set: {
        schemaVersion: values.schemaVersion,
        tradingDateKst: values.tradingDateKst,
        asOfAt: values.asOfAt,
        collectorRunId: values.collectorRunId,
        payloadHash,
        payload: values.payload,
        // DB clock (not Node) so captured_at stays monotonic vs the insert default.
        capturedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

/**
 * One metric's history, oldest-first, for charting. Ordered by bucket_key (the
 * trading day) rather than captured_at (when we wrote the row) — a re-collected
 * old bucket must not jump to the end of the series.
 */
export async function getStockHistory(
  symbol: string,
  metric: string,
  days: number,
): Promise<StockSnapshot[]> {
  const rows = await db
    .select()
    .from(stockSnapshots)
    .where(and(eq(stockSnapshots.symbol, symbol), eq(stockSnapshots.metric, metric)))
    .orderBy(desc(stockSnapshots.bucketKey))
    .limit(days);
  return rows.reverse();
}

export async function searchStockSnapshots(
  query: StockSnapshotQuery,
): Promise<StockSnapshot[]> {
  const filters: SQL[] = [];
  if (query.symbol) filters.push(eq(stockSnapshots.symbol, query.symbol));
  if (query.metric) filters.push(eq(stockSnapshots.metric, query.metric));
  if (query.source) filters.push(eq(stockSnapshots.source, query.source));
  const whereExpr = filters.length ? and(...filters) : undefined;

  const base = db.select().from(stockSnapshots);
  const filtered = whereExpr ? base.where(whereExpr) : base;
  const rows = await filtered
    .orderBy(desc(stockSnapshots.capturedAt))
    .limit(query.latest ? 500 : query.limit);

  if (!query.latest) return rows;

  // latest per (symbol, metric); rows already newest-first.
  const seen = new Set<string>();
  const out: StockSnapshot[] = [];
  for (const r of rows) {
    const k = `${r.symbol}|${r.metric}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(0, query.limit);
}
