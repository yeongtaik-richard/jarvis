import { NextResponse, type NextRequest } from 'next/server';

/**
 * Bearer 검사. 기본은 전권 토큰(`JARVIS_API_TOKEN`)만 통과한다.
 *
 * `{ also: 'briefing' }`을 준 라우트는 **브리핑 전용 토큰**(`JARVIS_BRIEFING_TOKEN`)도
 * 받는다. 자동 브리핑 루틴은 Anthropic 클라우드에 프롬프트로 토큰을 들고 있어야 해서,
 * 새는 경우를 전제로 권한을 최소로 묶었다 — 스냅샷·브리핑 읽기와 브리핑 쓰기까지만이고
 * 메모리·개선노트·수집기 보고·결정 로그에는 닿지 못한다.
 * 전용 토큰이 설정돼 있지 않으면 그냥 전권 토큰만 받는다(기능 off).
 */
export function checkBearer(
  req: NextRequest,
  opts?: { also?: 'briefing' },
): NextResponse | null {
  const expected = process.env.JARVIS_API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'server_misconfigured', detail: 'JARVIS_API_TOKEN not set' },
      { status: 500 },
    );
  }
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return unauthorized();

  if (timingSafeEqual(m[1], expected)) return null;

  const briefing = process.env.JARVIS_BRIEFING_TOKEN;
  if (opts?.also === 'briefing' && briefing && timingSafeEqual(m[1], briefing)) {
    return null;
  }
  return unauthorized();
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
