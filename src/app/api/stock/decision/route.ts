import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';
import { CreateTradeDecisionInput, TradeDecisionQuery } from '@/lib/schemas';
import {
  createTradeDecision,
  searchTradeDecisions,
  toApiTradeDecision,
} from '@/lib/trade-decision-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 사용자가 **실제로 한** 매매 결정을 기록한다. AI가 판단해서 만들어내는 게 아니라
 * "샀다/팔았다/안 했다"를 받아적는 자리다 (docs/stock.md §정직성).
 */
export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = CreateTradeDecisionInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const row = await createTradeDecision(parsed.data);
    return ok(toApiTradeDecision(row), 201);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = TradeDecisionQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchTradeDecisions(parsed.data);
    return ok({ items: rows.map(toApiTradeDecision), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
