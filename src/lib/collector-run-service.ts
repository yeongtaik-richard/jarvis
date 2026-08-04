import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { getMarketCalendar } from './market-calendar';
import { db } from '@/db/client';
import { collectorRuns, stockSnapshots, type CollectorRun } from '@/db/schema';
import type { CollectorRunQuery, ReportCollectorRunInput } from './schemas';

export type ApiCollectorRun = {
  id: string;
  symbol: string;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  posted: number;
  failed: number;
  error: string | null;
};

export function toApiCollectorRun(r: CollectorRun): ApiCollectorRun {
  return {
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    status: r.status,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
    posted: r.posted,
    failed: r.failed,
    error: r.error,
  };
}

/**
 * 수집기가 실행 시작/종료를 같은 id로 두 번 보고한다 (upsert). 시각은 DB `now()` —
 * 러너 시계를 믿지 않는다.
 */
export async function reportCollectorRun(
  input: ReportCollectorRunInput,
): Promise<CollectorRun> {
  const [row] = await db
    .insert(collectorRuns)
    .values({
      id: input.id,
      symbol: input.symbol,
      kind: input.kind,
      status: input.status,
      posted: input.posted,
      failed: input.failed,
      error: input.error ?? null,
      finishedAt: input.finished ? sql`now()` : null,
    })
    .onConflictDoUpdate({
      target: collectorRuns.id,
      set: {
        kind: input.kind,
        status: input.status,
        posted: input.posted,
        failed: input.failed,
        error: input.error ?? null,
        // 종료 보고일 때만 finished_at을 찍는다 (재시작 보고가 지워버리지 않도록).
        finishedAt: input.finished ? sql`now()` : sql`collector_runs.finished_at`,
      },
    })
    .returning();
  return row;
}

export async function searchCollectorRuns(
  query: CollectorRunQuery,
): Promise<CollectorRun[]> {
  const filters: SQL[] = [];
  if (query.symbol) filters.push(eq(collectorRuns.symbol, query.symbol));
  if (query.status) filters.push(eq(collectorRuns.status, query.status));
  const where = filters.length ? and(...filters) : undefined;

  const base = db.select().from(collectorRuns);
  const filtered = where ? base.where(where) : base;
  return filtered.orderBy(desc(collectorRuns.startedAt)).limit(query.limit);
}

const KST_OFFSET_MS = 9 * 3_600_000;
const CLOSE_RUN_MIN = 18 * 60 + 43; // .github/workflows/collect-stock.yml
/**
 * GitHub cron은 best-effort고 실제로 많이 늦는다 — 관측: 2026-07-29 마감분 2시간 5분 지연,
 * 07-30 프리마켓분 약 1시간 지연. 45분 유예로는 **지각한 실행을 누락으로 오탐**했다.
 * 하루 1회짜리 작업이라 몇 시간 늦게 알아도 늦지 않으니, 유예를 넉넉히 준다.
 */
const GRACE_MIN = 180;

/**
 * 이미 지났어야 할 가장 최근 마감 수집 시각(+유예). 이 시각 이후로 성공 실행이 없으면
 * 수집을 놓친 것이다.
 *
 * 주의: KRX 공휴일을 모른다 — 평일 휴장일에는 `missed`가 참으로 뜰 수 있다.
 * 알림을 무시해야 하는 케이스라 대시보드 문구에도 그 가능성을 적어둔다.
 */
/**
 * @param closed 휴장인 평일 (YYYY-MM-DD). 넘기면 휴장일을 건너뛰어 `missed` 오탐을
 *   막는다. 비워두면 주말만 거른다(예전 동작).
 */
export function lastExpectedCloseRun(now: Date, closed?: Set<string>): Date | null {
  for (let back = 0; back < 10; back++) {
    const shifted = new Date(now.getTime() + KST_OFFSET_MS - back * 86_400_000);
    const dow = shifted.getUTCDay(); // shifted의 UTC 필드 = KST 벽시계
    if (dow === 0 || dow === 6) continue;
    // 휴장일엔 수집이 돌 이유가 없다 — 여기서 걸러야 배너가 뜨지 않는다
    if (closed?.has(shifted.toISOString().slice(0, 10))) continue;
    const kstMidnight = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    );
    const expected = new Date(kstMidnight + (CLOSE_RUN_MIN + GRACE_MIN) * 60_000 - KST_OFFSET_MS);
    if (expected <= now) return expected;
  }
  return null;
}

export type CollectorHealth = {
  last_run: ApiCollectorRun | null;
  last_ok_run: ApiCollectorRun | null;
  expected_close_run_at: string | null;
  /** 기대 시각이 지났는데 그 이후 성공 실행이 없음. 휴장일은 제외하고 센다. */
  missed: boolean;
  hours_since_ok: number | null;
  latest_snapshots: { metric: string; bucket_key: string; captured_at: string }[];
};

export async function getCollectorHealth(
  symbol: string,
  now = new Date(),
): Promise<CollectorHealth> {
  const [lastRun] = await db
    .select()
    .from(collectorRuns)
    .where(eq(collectorRuns.symbol, symbol))
    .orderBy(desc(collectorRuns.startedAt))
    .limit(1);
  // 인트라데이 실행은 확정 데이터를 하나도 만들지 않으므로 `missed`를 지우면 안 된다
  // (그걸 세면 장중 실행 성공이 마감 수집 누락을 가려버린다). 프리마켓은 전날 확정분을
  // 다시 채우는 안전망이라 포함한다.
  const [lastOk] = await db
    .select()
    .from(collectorRuns)
    .where(
      and(
        eq(collectorRuns.symbol, symbol),
        eq(collectorRuns.status, 'ok'),
        ne(collectorRuns.kind, 'intraday'),
      ),
    )
    .orderBy(desc(collectorRuns.startedAt))
    .limit(1);

  const snaps = await db
    .selectDistinctOn([stockSnapshots.metric], {
      metric: stockSnapshots.metric,
      bucketKey: stockSnapshots.bucketKey,
      capturedAt: stockSnapshots.capturedAt,
    })
    .from(stockSnapshots)
    .where(eq(stockSnapshots.symbol, symbol))
    .orderBy(stockSnapshots.metric, desc(stockSnapshots.bucketKey));

  const calendar = await getMarketCalendar(symbol);
  const expected = lastExpectedCloseRun(now, calendar.closed);
  const okAt = lastOk?.finishedAt ?? lastOk?.startedAt ?? null;

  return {
    last_run: lastRun ? toApiCollectorRun(lastRun) : null,
    last_ok_run: lastOk ? toApiCollectorRun(lastOk) : null,
    expected_close_run_at: expected ? expected.toISOString() : null,
    missed: expected !== null && (okAt === null || okAt < expected),
    hours_since_ok: okAt ? (now.getTime() - okAt.getTime()) / 3_600_000 : null,
    latest_snapshots: snaps.map((s) => ({
      metric: s.metric,
      bucket_key: s.bucketKey,
      captured_at: s.capturedAt.toISOString(),
    })),
  };
}
