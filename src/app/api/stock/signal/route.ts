import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { jsonError, ok } from '@/lib/http';
import { getStockSignal, recordStockSignal } from '@/lib/stock-signal-service';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 규칙 기반 방향성 신호. **미검증이며 매매 지시가 아니다** — 응답의 disclaimer와
 * directional 적중률(표본 수 포함)을 떼어놓고 인용하면 안 된다.
 */
export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const symbol = new URL(req.url).searchParams.get('symbol') ?? '000660';
  try {
    return ok(await getStockSignal(symbol));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

/**
 * 오늘 신호를 directional 예측으로 기록한다 (마감 후 하루 1회 — 수집기가 부른다).
 * watch는 기록하지 않고, 같은 대상 버킷에 pending이 있으면 중복 기록하지 않는다.
 */
export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const symbol = new URL(req.url).searchParams.get('symbol') ?? '000660';
  try {
    const result = await recordStockSignal(symbol);
    return ok(result, result.recorded ? 201 : 200);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
