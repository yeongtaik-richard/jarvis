import { cache } from 'react';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions, stockSnapshots, type StockPrediction } from '@/db/schema';
import { HttpError } from './errors';
import type { CreatePredictionInput, PredictionQuery } from './schemas';

export type ApiPrediction = {
  id: string;
  symbol: string;
  created_at: string;
  analysis_id: string | null;
  authored_by: string;
  kind: string;
  claim: string;
  metric: string;
  field: string;
  comparator: string;
  threshold: number;
  target_bucket: string;
  status: string;
  actual_value: number | null;
  scored_at: string | null;
  score_note: string | null;
  /** 규칙 신호 레인의 판정 상태 박제 — passed=false면 게이트 검증용 표본이다 */
  context: unknown;
};

export function toApiPrediction(p: StockPrediction): ApiPrediction {
  return {
    id: p.id,
    symbol: p.symbol,
    created_at: p.createdAt.toISOString(),
    analysis_id: p.analysisId,
    authored_by: p.authoredBy,
    kind: p.kind,
    claim: p.claim,
    metric: p.metric,
    field: p.field,
    comparator: p.comparator,
    threshold: p.threshold,
    target_bucket: p.targetBucket,
    status: p.status,
    actual_value: p.actualValue,
    scored_at: p.scoredAt ? p.scoredAt.toISOString() : null,
    score_note: p.scoreNote,
    context: p.context ?? null,
  };
}

/** 대상 버킷 데이터가 이만큼 지나도 안 오면 영영 안 오는 것으로 본다 (휴장·수집 누락). */
const EXPIRE_GRACE_DAYS = 3;

const kstToday = (): string =>
  new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * 예측 등록. **이미 결과가 나와 있는 조건은 예측이 아니다** — 대상 버킷의 스냅샷이
 * 벌써 존재하면 409로 거부한다. 이 검사가 없으면 "지나간 데이터를 맞히는" 가짜
 * 적중률이 쌓여 채점 전체가 무의미해진다.
 */
export async function createPrediction(
  input: CreatePredictionInput,
): Promise<StockPrediction> {
  const [existing] = await db
    .select({ id: stockSnapshots.id })
    .from(stockSnapshots)
    .where(
      and(
        eq(stockSnapshots.symbol, input.symbol),
        eq(stockSnapshots.metric, input.metric),
        eq(stockSnapshots.bucketKey, input.target_bucket),
      ),
    )
    .limit(1);
  if (existing) {
    throw new HttpError(409, 'already_observable', {
      detail: `${input.metric}@${input.target_bucket} 스냅샷이 이미 존재한다 — 결과가 나온 뒤의 등록은 예측이 아니다`,
    });
  }

  const [row] = await db
    .insert(stockPredictions)
    .values({
      symbol: input.symbol,
      analysisId: input.analysis_id ?? null,
      authoredBy: input.authored_by,
      kind: input.kind,
      claim: input.claim,
      metric: input.metric,
      field: input.field,
      comparator: input.comparator,
      threshold: input.threshold,
      targetBucket: input.target_bucket,
      context: input.context ?? null,
    })
    .returning();
  return row;
}

/**
 * 요청 1회당 한 번만 돈다. searchPredictions·predictionStats·getPredictionLedger가
 * 각각 "조회가 곧 채점" 규약으로 부르는데, 셋 다 같은 페이지에서 불려서 같은 일을
 * 세 번 했다. 채점 자체는 멱등이라 결과는 같았지만 왕복만 3배였다.
 */
export const scorePending = cache(scorePendingUncached);

/**
 * 페이로드에서 채점할 값을 꺼낸다.
 *
 * 보통은 `payload[field]`면 끝인데 **분봉만 예외**다. 분봉은 시간 버킷 한 행에 그 시간의
 * 분봉 배열이 들어 있어서(하루 390행이 아니라 7행), 'HH:MM' 형태의 field는 그 배열
 * 안에서 해당 분을 찾아야 한다. 1시간 지평이 "정확히 60분 뒤"로 채점되려면 이게 있어야
 * 한다 — 시간 버킷 단위로 뭉뚱그리면 수집 지연만큼 지평이 흔들린다.
 */
function resolveField(payload: unknown, field: string): number {
  const p = payload as Record<string, unknown> | null;
  if (!p) return NaN;
  if (/^\d{2}:\d{2}$/.test(field) && Array.isArray(p.bars)) {
    const bar = (p.bars as Array<Record<string, unknown>>).find((b) => b.t === field);
    return bar ? Number(bar.c) : NaN;
  }
  return Number(p[field]);
}

const CMP: Record<string, (v: number, t: number) => boolean> = {
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
};

/**
 * pending 예측을 결정론적으로 채점한다. 조회 경로에서 매번 불러도 안전하다(멱등) —
 * 별도 cron 없이, 데이터가 도착해 있으면 그 시점의 조회가 채점을 겸한다.
 *
 * - 스냅샷 있음 → 필드 비교 → confirmed / refuted. 필드가 없거나 숫자가 아니면 unverifiable.
 * - 스냅샷 없음 + 대상 날짜가 3일 넘게 지남 → expired (휴장일 예측, 수집 누락 등).
 */
async function scorePendingUncached(symbol: string): Promise<number> {
  const pending = await db
    .select()
    .from(stockPredictions)
    .where(and(eq(stockPredictions.symbol, symbol), eq(stockPredictions.status, 'pending')));
  if (!pending.length) return 0;

  // 대상 스냅샷을 **한 번에** 가져온다. 건별로 왕복하면 Neon 서버리스에서 건당
  // ~100ms라 12건이면 1.2초가 되고, 이 함수는 페이지 한 번에 여러 곳에서 불린다.
  // metric × bucket 교차곱이라 필요 없는 조합도 딸려오지만, Map 조회가 정확한 짝만
  // 집어내므로 문제없다. 몇 행 더 읽는 값으로 왕복 N회를 1회로 줄인다.
  const snapRows = await db
    .select({
      metric: stockSnapshots.metric,
      bucketKey: stockSnapshots.bucketKey,
      payload: stockSnapshots.payload,
    })
    .from(stockSnapshots)
    .where(
      and(
        eq(stockSnapshots.symbol, symbol),
        inArray(stockSnapshots.metric, [...new Set(pending.map((p) => p.metric))]),
        inArray(stockSnapshots.bucketKey, [...new Set(pending.map((p) => p.targetBucket))]),
      ),
    );
  const snapByKey = new Map(snapRows.map((r) => [`${r.metric}\u0000${r.bucketKey}`, r]));

  const today = kstToday();
  let scored = 0;

  for (const p of pending) {
    const snap = snapByKey.get(`${p.metric}\u0000${p.targetBucket}`);

    if (snap) {
      const v = resolveField(snap.payload, p.field);
      const cmp = CMP[p.comparator];
      if (!Number.isFinite(v) || !cmp) {
        await db
          .update(stockPredictions)
          .set({
            status: 'unverifiable',
            scoredAt: sql`now()`,
            scoreNote: `payload.${p.field}가 숫자가 아니거나 없음`,
          })
          .where(eq(stockPredictions.id, p.id));
      } else {
        const pass = cmp(v, p.threshold);
        await db
          .update(stockPredictions)
          .set({
            status: pass ? 'confirmed' : 'refuted',
            actualValue: v,
            scoredAt: sql`now()`,
            scoreNote: `실측 ${v} ${p.comparator} ${p.threshold} → ${pass}`,
          })
          .where(eq(stockPredictions.id, p.id));
      }
      scored++;
      continue;
    }

    // 대상 날짜(버킷 앞 10자)가 유예를 넘겨 지났는데 데이터가 없다 → 만료
    const targetDate = p.targetBucket.slice(0, 10);
    const ageDays =
      (Date.parse(today) - Date.parse(targetDate)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > EXPIRE_GRACE_DAYS) {
      await db
        .update(stockPredictions)
        .set({
          status: 'expired',
          scoredAt: sql`now()`,
          scoreNote: `${targetDate} + ${EXPIRE_GRACE_DAYS}일 유예까지 ${p.metric} 스냅샷이 오지 않음`,
        })
        .where(eq(stockPredictions.id, p.id));
      scored++;
    }
  }
  return scored;
}

export async function searchPredictions(
  query: PredictionQuery,
): Promise<StockPrediction[]> {
  // 조회가 곧 채점 기회다 — pending을 먼저 정산하고 읽는다.
  if (query.symbol) await scorePending(query.symbol);

  const filters: SQL[] = [];
  if (query.symbol) filters.push(eq(stockPredictions.symbol, query.symbol));
  if (query.status) filters.push(eq(stockPredictions.status, query.status));
  if (query.authored_by) filters.push(eq(stockPredictions.authoredBy, query.authored_by));
  const where = filters.length ? and(...filters) : undefined;

  const base = db.select().from(stockPredictions);
  const filtered = where ? base.where(where) : base;
  return filtered.orderBy(desc(stockPredictions.createdAt)).limit(query.limit);
}

export type PredictionStats = {
  symbol: string;
  total: number;
  pending: number;
  confirmed: number;
  refuted: number;
  expired: number;
  unverifiable: number;
  /** confirmed / (confirmed + refuted). 채점 완료분만 대상. */
  hit_rate: number | null;
  scored: number;
  by_author: { authored_by: string; confirmed: number; refuted: number; hit_rate: number | null }[];
};

/** 적중률 요약. validated_directional 해금 논의는 이 숫자 위에서만 한다. */
export async function predictionStats(symbol: string): Promise<PredictionStats> {
  await scorePending(symbol);
  const rows = await db
    .select({
      status: stockPredictions.status,
      authoredBy: stockPredictions.authoredBy,
      n: sql<number>`count(*)::int`,
    })
    .from(stockPredictions)
    .where(eq(stockPredictions.symbol, symbol))
    .groupBy(stockPredictions.status, stockPredictions.authoredBy);

  const count = (st: string) =>
    rows.filter((r) => r.status === st).reduce((a, r) => a + r.n, 0);
  const confirmed = count('confirmed');
  const refuted = count('refuted');

  const authors = [...new Set(rows.map((r) => r.authoredBy))].map((a) => {
    const c = rows.find((r) => r.authoredBy === a && r.status === 'confirmed')?.n ?? 0;
    const f = rows.find((r) => r.authoredBy === a && r.status === 'refuted')?.n ?? 0;
    return {
      authored_by: a,
      confirmed: c,
      refuted: f,
      hit_rate: c + f > 0 ? Number((c / (c + f)).toFixed(3)) : null,
    };
  });

  return {
    symbol,
    total: rows.reduce((a, r) => a + r.n, 0),
    pending: count('pending'),
    confirmed,
    refuted,
    expired: count('expired'),
    unverifiable: count('unverifiable'),
    hit_rate: confirmed + refuted > 0 ? Number((confirmed / (confirmed + refuted)).toFixed(3)) : null,
    scored: confirmed + refuted,
    by_author: authors,
  };
}
