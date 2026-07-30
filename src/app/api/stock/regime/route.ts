import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';
import { getStockRegime } from '@/lib/stock-regime-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 저장된 일봉·수급으로 계산한 지표와 규칙 기반 국면 라벨. 저장하지 않고 매번 계산한다.
 * **예측이 아니다** — 응답의 `regime.disclaimer`가 그 사실을 같이 실어 보낸다.
 */
export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const params = new URL(req.url).searchParams;
  const symbol = params.get('symbol') ?? '000660';
  const daysRaw = Number(params.get('days') ?? '300');
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 20), 1000) : 300;

  try {
    return ok(await getStockRegime(symbol, days));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
