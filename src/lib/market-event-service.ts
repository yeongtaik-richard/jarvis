import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { marketEvents, type MarketEvent } from '@/db/schema';
import type { CreateMarketEventInput, MarketEventQuery } from './schemas';

export type ApiMarketEvent = {
  id: string;
  symbol: string;
  source: string;
  external_id: string;
  published_at: string;
  title: string;
  url: string | null;
  publisher: string | null;
  category: string | null;
  collected_at: string;
};

export function toApiMarketEvent(e: MarketEvent): ApiMarketEvent {
  return {
    id: e.id,
    symbol: e.symbol,
    source: e.source,
    external_id: e.externalId,
    published_at: e.publishedAt.toISOString(),
    title: e.title,
    url: e.url,
    publisher: e.publisher,
    category: e.category,
    collected_at: e.collectedAt.toISOString(),
  };
}

/**
 * (source, external_id) 자연키로 upsert. 같은 공시·기사를 다시 수집해도 한 행이다.
 * 제목은 갱신 대상 — 언론사가 헤드라인을 고치는 일이 있다. `published_at`은 갱신하지
 * 않는다: 최초 발행 시각이 이벤트의 정체성이고, 시각이 흔들리면 급변 구간 대조가 깨진다.
 */
export async function upsertMarketEvents(
  inputs: CreateMarketEventInput[],
): Promise<number> {
  if (!inputs.length) return 0;
  const rows = await db
    .insert(marketEvents)
    .values(
      inputs.map((i) => ({
        symbol: i.symbol,
        source: i.source,
        externalId: i.external_id,
        publishedAt: i.published_at,
        title: i.title,
        url: i.url ?? null,
        publisher: i.publisher ?? null,
        category: i.category ?? null,
        collectorRunId: i.collector_run_id ?? null,
        raw: i.raw,
      })),
    )
    .onConflictDoUpdate({
      target: [marketEvents.source, marketEvents.externalId],
      set: {
        title: sql`excluded.title`,
        url: sql`excluded.url`,
        publisher: sql`excluded.publisher`,
        category: sql`excluded.category`,
        raw: sql`excluded.raw`,
        collectedAt: sql`now()`,
      },
    })
    .returning({ id: marketEvents.id });
  return rows.length;
}

export async function searchMarketEvents(
  query: MarketEventQuery,
): Promise<MarketEvent[]> {
  const filters: SQL[] = [];
  if (query.symbol) filters.push(eq(marketEvents.symbol, query.symbol));
  if (query.source) filters.push(eq(marketEvents.source, query.source));
  if (query.since) filters.push(gte(marketEvents.publishedAt, query.since));
  const where = filters.length ? and(...filters) : undefined;

  const base = db.select().from(marketEvents);
  const filtered = where ? base.where(where) : base;
  return filtered.orderBy(desc(marketEvents.publishedAt)).limit(query.limit);
}
