/**
 * 지평 보드 조립 — 선언(horizon-board.ts)에 실제 데이터를 채운다.
 *
 * 채우지 못하는 칸은 **채우지 않는다.** 보드의 값어치는 "무엇을 아직 말할 수 없는지"가
 * 한눈에 보이는 데 있고, 빈칸을 그럴듯한 숫자로 메우면 그 값어치가 사라진다.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { stockPredictions, stockSnapshots } from '@/db/schema';
import { HORIZON_BOARD, tradingDaysTo30Samples, type HorizonSpec } from './horizon-board';
import { getPredictionLedger, type RunningRecord } from './prediction-ledger';
import { computeStockPosition, type QuarterPoint, type StockPosition } from './stock-position';
import { getStockHistory } from './stock-service';
import { getStockSignal } from './stock-signal-service';

export interface HorizonRow extends HorizonSpec {
  /** 지금 이 지평이 가리키는 방향 (live일 때만) */
  direction: 'up' | 'down' | null;
  /** 채점 대상 거래일 */
  target: string | null;
  /** 실전 성적 */
  record: RunningRecord | null;
  /** 30표본까지 남은 거래일 (대략) */
  daysTo30: number;
  /** position_only 지평이 보여줄 것 */
  position: StockPosition | null;
}

export interface HorizonBoard {
  rows: HorizonRow[];
  /** 분봉이 며칠치 쌓였나 — 짧은 지평의 진행 상황 */
  minuteDays: number;
  asOf: string | null;
}

const n = (p: unknown, k: string): number | null => {
  const v = Number((p as Record<string, unknown> | null)?.[k]);
  return Number.isFinite(v) ? v : null;
};

export async function getHorizonBoard(symbol: string): Promise<HorizonBoard> {
  const [signal, ledger, bars, fin, val, minuteRows, intradayCounts, pendingRows] =
    await Promise.all([
    getStockSignal(symbol),
    getPredictionLedger(symbol, { settledLimit: 200 }),
    getStockHistory(symbol, 'daily_ohlcv', 320),
    getStockHistory(symbol, 'quarter_financials', 1),
    getStockHistory(symbol, 'valuation', 1),
    db
      .select({ bucketKey: stockSnapshots.bucketKey })
      .from(stockSnapshots)
      .where(and(eq(stockSnapshots.symbol, symbol), eq(stockSnapshots.metric, 'minute_bars')))
      .orderBy(desc(stockSnapshots.bucketKey))
      .limit(400),
    // 장중 레인은 장부(일별 HORIZONS 기반)에 없어서 예측 테이블을 직접 센다.
    db
      .select({
        kind: stockPredictions.kind,
        status: stockPredictions.status,
        n: sql<number>`count(*)::int`,
      })
      .from(stockPredictions)
      .where(
        and(
          eq(stockPredictions.symbol, symbol),
          inArray(stockPredictions.kind, INTRADAY_KINDS),
        ),
      )
      .groupBy(stockPredictions.kind, stockPredictions.status),
    // 대기 중인 예측의 **기록된 방향**. 보드는 이걸 보여준다 — 지금 규칙을 다시 돌린
    // 값을 보여주면 채점되는 것과 다른 방향이 화면에 뜰 수 있다.
    db
      .select({
        kind: stockPredictions.kind,
        comparator: stockPredictions.comparator,
        targetBucket: stockPredictions.targetBucket,
        createdAt: stockPredictions.createdAt,
      })
      .from(stockPredictions)
      .where(
        and(eq(stockPredictions.symbol, symbol), eq(stockPredictions.status, 'pending')),
      )
      .orderBy(desc(stockPredictions.createdAt))
      .limit(40),
  ]);

  const closes = bars.map((b) => n(b.payload, 'close')!).filter(Number.isFinite);
  const quarters = (((fin[0]?.payload as Record<string, unknown>)?.quarters ?? []) as QuarterPoint[]);
  const position = computeStockPosition(closes, quarters, val[0] ? n(val[0].payload, 'per') : null);
  const minuteDays = new Set(minuteRows.map((r) => r.bucketKey.slice(0, 10))).size;

  // 레인별 실전 성적. 장부는 kind로 갈라져 있다.
  const recordFor = (kind: string): RunningRecord | null => {
    const es = [...ledger.settled, ...ledger.due, ...ledger.open].filter(
      (e) => e.passed && KIND_OF[e.horizon] === kind,
    );
    const scored = es.filter((e) => e.status === 'confirmed' || e.status === 'refuted');
    if (es.length === 0) return null;
    const hits = scored.filter((e) => e.status === 'confirmed').length;
    return {
      scored: scored.length,
      hits,
      hit_rate: scored.length ? Number((hits / scored.length).toFixed(3)) : null,
      streak: 0,
    };
  };

  const intradayRecord = (kind: string): RunningRecord | null => {
    const rows = intradayCounts.filter((r) => r.kind === kind);
    if (rows.length === 0) return null;
    const get = (st: string) => rows.find((r) => r.status === st)?.n ?? 0;
    const hits = get('confirmed');
    const scored = hits + get('refuted');
    return {
      scored,
      hits,
      hit_rate: scored ? Number((hits / scored).toFixed(3)) : null,
      streak: 0,
    };
  };

  // kind별 가장 최근 대기 예측의 방향 (comparator gt=위, lt=아래)
  const pendingDir = new Map<string, 'up' | 'down'>();
  for (const r of pendingRows) {
    if (!pendingDir.has(r.kind)) {
      pendingDir.set(r.kind, r.comparator === 'gt' ? 'up' : 'down');
    }
  }

  const rows: HorizonRow[] = HORIZON_BOARD.map((spec) => {
    // HorizonView는 key('d1'/'d5')로 식별한다. spec.kind는 예측 레코드의 kind라 축이 다르다.
    const viewKey = Object.entries(KIND_OF).find(([, k]) => k === spec.kind)?.[0];
    const hz = signal.horizons.find((h) => h.key === viewKey);
    return {
      ...spec,
      // **기록된** 예측의 방향을 보여준다. 지금 규칙을 다시 돌린 값이 아니다 —
      // 임계값이 바뀌거나 데이터가 갱신되면 둘이 갈라지고, 채점은 기록된 쪽으로
      // 되므로 화면이 거짓말을 하게 된다.
      direction: spec.kind ? (pendingDir.get(spec.kind) ?? null) : null,
      target: hz?.target_bucket ?? null,
      record: spec.kind
        ? INTRADAY_KINDS.includes(spec.kind)
          ? intradayRecord(spec.kind)
          : recordFor(spec.kind)
        : null,
      daysTo30: tradingDaysTo30Samples(spec),
      position: spec.status === 'position_only' ? position : null,
    };
  });

  return { rows, minuteDays, asOf: signal.as_of };
}

/** 장부 항목의 horizon 키 → 예측 kind. HORIZONS와 짝이 맞아야 한다. */
const KIND_OF: Record<string, string> = {
  d1: 'directional_1d',
  d5: 'directional',
};

/** 장중 레인은 장부(HORIZONS 기반)에 없어서 예측 테이블을 직접 센다. */
const INTRADAY_KINDS = ['directional_h1', 'directional_d0'];
