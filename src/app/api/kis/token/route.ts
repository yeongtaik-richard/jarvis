import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';
import { PutServiceTokenInput } from '@/lib/schemas';
import { getServiceToken, putServiceToken } from '@/lib/service-token-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME = 'kis_access_token';

/**
 * 수집기의 KIS 토큰 캐시. **전권 토큰만** 받는다 — 브리핑 토큰은 클라우드 루틴이
 * 프롬프트로 들고 다녀서 샌다고 가정하는 값이라, 여기 닿으면 안 된다.
 *
 * 서버는 암호문을 보관만 하고 열지 못한다. 복호화 키는 KIS_APP_SECRET에서 파생되고
 * 그건 수집기(GitHub Secrets/로컬)에만 있다. 이 라우트가 새더라도 공격자가 얻는 것은
 * 열쇠 없는 덩어리다.
 */
export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  try {
    return ok(await getServiceToken(NAME));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = PutServiceTokenInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    await putServiceToken({ name: NAME, ...parsed.data });
    return ok({ stored: true }, 201);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
