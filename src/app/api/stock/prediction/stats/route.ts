import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { jsonError, ok } from '@/lib/http';
import { predictionStats } from '@/lib/prediction-service';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 예측 적중률 요약. `validated_directional` 해금 논의는 이 통계 위에서만 한다 —
 * 표본이 몇 건인지 없이 적중률만 인용하지 말 것.
 */
export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const symbol = new URL(req.url).searchParams.get('symbol') ?? '000660';
  try {
    return ok(await predictionStats(symbol));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
