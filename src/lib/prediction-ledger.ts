/**
 * 예측 장부 — "어제 뭐랬는데 오늘 맞았나"를 날짜순으로 세운 것.
 *
 * 대시보드의 신호 카드는 *지금* 규칙이 뭐라 하는지만 보여준다. 그것만으로는 규칙을
 * 믿을 근거가 안 쌓인다. 사람이 신뢰를 만드는 방식은 "저번에 뭐랬더라 → 맞았나"의
 * 반복이고, 이 파일은 그 반복을 화면에 세운다.
 *
 * 여기서는 **아무것도 계산하지 않는다**. 기록된 예측 행을 시점별로 묶기만 한다 —
 * 재현(replay)으로 장부를 채우면 사후에 지어낸 예측이 섞여 장부의 존재 이유가
 * 사라진다. 그래서 장부가 비어 있는 기간은 비어 있는 채로 둔다.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions, type StockPrediction } from '@/db/schema';
import { scorePending } from './prediction-service';
import { HORIZONS } from './stock-signal';

export type LedgerContext = {
  /** 기준 봉의 거래일 — 예측을 건 근거가 된 확정 종가의 날짜 */
  as_of?: string;
  score?: number;
  passed?: boolean;
  gated?: boolean;
  volatility?: string;
  components?: Record<string, number>;
};

export type LedgerEntry = {
  id: string;
  /** 'd1' | 'd5' */
  horizon: string;
  horizon_label: string;
  /** 판정 기준일 (예측을 건 날의 확정 봉) */
  as_of: string;
  /** 채점 대상 거래일 */
  target: string;
  direction: 'buy' | 'sell';
  /** 기준 종가 */
  reference: number;
  /** 채점된 경우 대상일 실제 종가 */
  actual: number | null;
  /** 기준 대비 실제 변화율 (%) */
  change_pct: number | null;
  status: string;
  /** 게이트를 통과한 신호인가. false면 게이트 검증용 표본이다. */
  passed: boolean;
  score: number | null;
  gated: boolean;
  volatility: string | null;
  components: Record<string, number>;
};

export type RunningRecord = {
  scored: number;
  hits: number;
  hit_rate: number | null;
  /** 최근 것부터 연속 적중/빗나감 (양수=적중 연속, 음수=빗나감 연속) */
  streak: number;
};

export type PredictionLedger = {
  /** 오늘(또는 최근 거래일) 결과가 나올 차례인데 아직 채점 안 된 것 */
  due: LedgerEntry[];
  /** 최근 채점이 끝난 것 (최신순) */
  settled: LedgerEntry[];
  /** 지금 걸려 있는 것 — 미래에 채점된다 (target 오름차순) */
  open: LedgerEntry[];
  /** 통과 신호만의 누적 성적 */
  running: RunningRecord;
  /** 게이트 차단분의 누적 성적 — 통과분보다 좋으면 게이트가 틀렸다는 증거 */
  running_blocked: RunningRecord;
};

const HORIZON_BY_KIND = new Map(HORIZONS.map((h) => [h.kind as string, h]));

function toEntry(r: StockPrediction): LedgerEntry {
  const ctx = (r.context ?? {}) as LedgerContext;
  const h = HORIZON_BY_KIND.get(r.kind);
  const ref = r.threshold;
  const actual = r.actualValue;
  return {
    id: r.id,
    horizon: h?.key ?? r.kind,
    horizon_label: h?.label ?? r.kind,
    // 기준 봉의 거래일. context에 박아둔 값이 정답이고, 없는 옛 행만 created_at으로
    // 근사한다 (그 행들은 전부 마감 후 기록이라 근사가 맞는다).
    as_of:
      ctx.as_of ?? new Date(r.createdAt.getTime() + 9 * 3_600_000).toISOString().slice(0, 10),
    target: r.targetBucket,
    direction: r.comparator === 'gt' ? 'buy' : 'sell',
    reference: ref,
    actual,
    change_pct:
      actual !== null && ref > 0 ? Number((((actual - ref) / ref) * 100).toFixed(2)) : null,
    status: r.status,
    passed: ctx.passed !== false, // context 없는 옛 행은 통과분이었다
    score: typeof ctx.score === 'number' ? ctx.score : null,
    gated: ctx.gated === true,
    volatility: ctx.volatility ?? null,
    components: ctx.components ?? {},
  };
}

function record(entries: LedgerEntry[]): RunningRecord {
  const scored = entries.filter((e) => e.status === 'confirmed' || e.status === 'refuted');
  const hits = scored.filter((e) => e.status === 'confirmed').length;
  let streak = 0;
  for (const e of scored) {
    // entries는 최신순 — 첫 항목의 부호를 유지하는 동안만 센다
    const hit = e.status === 'confirmed';
    if (streak === 0) streak = hit ? 1 : -1;
    else if (hit && streak > 0) streak++;
    else if (!hit && streak < 0) streak--;
    else break;
  }
  return {
    scored: scored.length,
    hits,
    hit_rate: scored.length > 0 ? Number((hits / scored.length).toFixed(3)) : null,
    streak,
  };
}

const kstToday = (): string => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * 장부를 만든다. 조회가 곧 채점이다 — `scorePending`을 먼저 돌려 결과가 나온 예측을
 * 정산한 뒤 읽는다 (predictionStats와 같은 규약).
 */
export async function getPredictionLedger(
  symbol: string,
  opts: { settledLimit?: number } = {},
): Promise<PredictionLedger> {
  await scorePending(symbol);

  const kinds = HORIZONS.map((h) => h.kind as string);
  const today = kstToday();

  const rows = await db
    .select()
    .from(stockPredictions)
    .where(
      and(
        eq(stockPredictions.symbol, symbol),
        inArray(stockPredictions.kind, kinds),
        // 장부는 최근 것만 본다 — 누적 성적은 아래에서 따로 센다
        gte(stockPredictions.targetBucket, sql`to_char(now() - interval '120 days', 'YYYY-MM-DD')`),
      ),
    )
    .orderBy(desc(stockPredictions.targetBucket), desc(stockPredictions.createdAt));

  const all = rows.map(toEntry);
  const pending = all.filter((e) => e.status === 'pending');

  return {
    // 대상일이 지났거나 오늘인데 아직 채점 전 — "오늘 판가름난다"
    due: pending.filter((e) => e.target <= today),
    settled: all
      .filter((e) => e.status === 'confirmed' || e.status === 'refuted')
      .slice(0, opts.settledLimit ?? 12),
    open: pending.filter((e) => e.target > today).sort((a, b) => a.target.localeCompare(b.target)),
    running: record(all.filter((e) => e.passed)),
    running_blocked: record(all.filter((e) => !e.passed)),
  };
}
