import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { fromZod, jsonError, ok } from '@/lib/http';
import { createOrSupersede, search, toApiMemory } from '@/lib/memory-service';
import { CreateMemoryInput, SearchQuery } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authError = checkBearer(req);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = CreateMemoryInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const created = await createOrSupersede(parsed.data);
    return ok(toApiMemory(created), 201);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
}

export async function GET(req: NextRequest) {
  const authError = checkBearer(req);
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = SearchQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const results = await search(parsed.data);
    return ok({ items: results.map(toApiMemory), count: results.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
}
