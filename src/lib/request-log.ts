import { after, NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db/client';
import { requestLogs } from '@/db/schema';

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<NextResponse>;

export function withLog<Ctx = unknown>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    const start = Date.now();
    let response: NextResponse;
    let errorMsg: string | null = null;

    try {
      response = await handler(req, ctx);
    } catch (e) {
      errorMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(e);
      response = NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    const status = response.status;
    const durationMs = Date.now() - start;
    const path = new URL(req.url).pathname;
    const method = req.method;
    const userAgent = req.headers.get('user-agent');
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      null;

    after(async () => {
      try {
        await db.insert(requestLogs).values({
          method,
          path,
          status,
          durationMs,
          error: errorMsg,
          userAgent,
          ip,
        });
      } catch (e) {
        console.error('request log insert failed', e);
      }
    });

    return response;
  };
}
