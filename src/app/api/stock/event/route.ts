import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import {
  searchMarketEvents,
  toApiMarketEvent,
  upsertMarketEvents,
} from '@/lib/market-event-service';
import { withLog } from '@/lib/request-log';
import { CreateMarketEventInput, MarketEventQuery } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 수집기가 한 번에 여러 건 올리므로 배열도 받는다.
const Body = z.union([CreateMarketEventInput, z.array(CreateMarketEventInput).max(200)]);

/** 공시·뉴스 upsert. **수집기 전용** — 모델이 사건을 만들어 넣을 자리가 아니다. */
export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    return ok({ upserted: await upsertMarketEvents(items) }, 201);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const GET = withLog(async (req: NextRequest) => {
  // 브리핑 루틴이 "급락 구간에 무슨 일이 있었나"를 보려면 읽어야 한다.
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = MarketEventQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchMarketEvents(parsed.data);
    return ok({ items: rows.map(toApiMarketEvent), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
