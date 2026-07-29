import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { checkBearer } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { fromZod, jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';
import { PatchTradeDecisionInput } from '@/lib/schemas';
import {
  getTradeDecisionById,
  patchTradeDecision,
  toApiTradeDecision,
} from '@/lib/trade-decision-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();
type Ctx = { params: Promise<{ id: string }> };

export const GET = withLog<Ctx>(async (req: NextRequest, ctx: Ctx) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return jsonError(400, 'invalid_id');

  try {
    const row = await getTradeDecisionById(id);
    if (!row) return jsonError(404, 'not_found');
    return ok(toApiTradeDecision(row));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

/** 결과·교훈을 붙여 루프를 닫는다. */
export const PATCH = withLog<Ctx>(async (req: NextRequest, ctx: Ctx) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return jsonError(400, 'invalid_id');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = PatchTradeDecisionInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    return ok(toApiTradeDecision(await patchTradeDecision(id, parsed.data)));
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
