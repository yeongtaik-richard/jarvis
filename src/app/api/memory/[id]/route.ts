import { after, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkBearer } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { fromZod, jsonError, ok } from '@/lib/http';
import {
  createOrSupersede,
  getById,
  getThreadHistory,
  softDelete,
  toApiMemory,
} from '@/lib/memory-service';
import { syncThreadToCalendar } from '@/lib/calendar-sync';
import { withLog } from '@/lib/request-log';
import { PatchMemoryInput } from '@/lib/schemas';

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
    const row = await getById(id);
    if (!row) return jsonError(404, 'not_found');

    const includeHistory = new URL(req.url).searchParams.get('include_history') === 'true';
    if (!includeHistory) return ok(toApiMemory(row));

    const history = await getThreadHistory(row.threadId);
    return ok({ ...toApiMemory(row), history: history.map(toApiMemory) });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

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

  const parsed = PatchMemoryInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const created = await createOrSupersede({ ...parsed.data, supersedes_id: id });
    after(() => syncThreadToCalendar(created.threadId));
    return ok(toApiMemory(created), 201);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const DELETE = withLog<Ctx>(async (req: NextRequest, ctx: Ctx) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return jsonError(400, 'invalid_id');

  try {
    const tombstone = await softDelete(id);
    after(() => syncThreadToCalendar(tombstone.threadId));
    return ok(toApiMemory(tombstone), 200);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
