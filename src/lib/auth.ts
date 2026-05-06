import { NextResponse, type NextRequest } from 'next/server';

export function checkBearer(req: NextRequest): NextResponse | null {
  const expected = process.env.JARVIS_API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'server_misconfigured', detail: 'JARVIS_API_TOKEN not set' },
      { status: 500 },
    );
  }
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !timingSafeEqual(m[1], expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
