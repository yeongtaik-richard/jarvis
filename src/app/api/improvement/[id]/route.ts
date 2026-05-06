import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { checkBearer } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { fromZod, jsonError, ok } from '@/lib/http';
import {
  getImprovementById,
  patchImprovement,
  toApiImprovement,
} from '@/lib/improvement-service';
import { PatchImprovementInput } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const authError = checkBearer(req);
  if (authError) return authError;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return jsonError(400, 'invalid_id');

  try {
    const row = await getImprovementById(id);
    if (!row) return jsonError(404, 'not_found');
    return ok(toApiImprovement(row));
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
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

  const parsed = PatchImprovementInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const updated = await patchImprovement(id, parsed.data);
    return ok(toApiImprovement(updated));
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
}
