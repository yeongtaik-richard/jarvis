import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { getCollectorHealth } from '@/lib/collector-run-service';
import { jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 수집이 살아있는지 한 번에 보는 엔드포인트. `missed: true`면 마감 수집이 기대 시각까지
 * 성공하지 못한 것 — 다만 KRX 공휴일에는 오탐이 난다 (스케줄은 공휴일을 모른다).
 */
export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  const symbol = new URL(req.url).searchParams.get('symbol') ?? '000660';
  try {
    return ok(await getCollectorHealth(symbol));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
