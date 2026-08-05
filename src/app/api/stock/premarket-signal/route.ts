import { checkBearer } from '@/lib/auth';
import { jsonError, ok } from '@/lib/http';
import { recordPremarketSignal } from '@/lib/stock-premarket-service';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 프리마켓 예측(당일 시가·종가)을 기록한다. 수집기가 premarket 실행 끝에 부른다.
 * 개장(09:00) 이후 호출은 서버가 거절한다 — 시가를 보고 시가를 예측할 수 없다.
 */
export const POST = withLog(async (req) => {
  const denied = checkBearer(req, { also: 'briefing' });
  if (denied) return denied;
  const symbol = new URL(req.url).searchParams.get('symbol') ?? '000660';
  try {
    return ok(await recordPremarketSignal(symbol));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
