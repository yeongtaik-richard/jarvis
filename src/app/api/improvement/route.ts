import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import {
  createImprovement,
  searchImprovements,
  toApiImprovement,
} from '@/lib/improvement-service';
import { CreateImprovementInput, ImprovementSearchQuery } from '@/lib/schemas';

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

  const parsed = CreateImprovementInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const note = await createImprovement(parsed.data);
    return ok(toApiImprovement(note), 201);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
}

export async function GET(req: NextRequest) {
  const authError = checkBearer(req);
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = ImprovementSearchQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchImprovements(parsed.data);
    return ok({ items: rows.map(toApiImprovement), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
}
