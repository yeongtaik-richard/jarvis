import { checkBearer } from '@/lib/auth';
import { jsonError, ok } from '@/lib/http';
import { recordIntradaySignal } from '@/lib/stock-intraday-signal-service';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 장중 예측(1시간 뒤·오늘 마감)을 기록한다. 수집기가 장중 실행 끝에 부른다.
 *
 * LLM 세션에 맡기지 않는 이유는 일별 신호와 같다 — 기록은 결정론적이어야 하고,
 * 루틴이 안 떠도 표본이 쌓여야 한다. 서버가 방향 없음/중복/장 밖이면 알아서 건너뛴다.
 */
export const POST = withLog(async (req) => {
  const denied = checkBearer(req, { also: 'briefing' });
  if (denied) return denied;
  const symbol = new URL(req.url).searchParams.get('symbol') ?? '000660';
  try {
    return ok(await recordIntradaySignal(symbol));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
