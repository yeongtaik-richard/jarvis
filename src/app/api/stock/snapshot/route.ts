import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';
import { CreateStockSnapshotInput, StockSnapshotQuery } from '@/lib/schemas';
import {
  searchStockSnapshots,
  toApiStockSnapshot,
  upsertStockSnapshot,
} from '@/lib/stock-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = CreateStockSnapshotInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const row = await upsertStockSnapshot(parsed.data);
    return ok(toApiStockSnapshot(row), 201);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = StockSnapshotQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchStockSnapshots(parsed.data);
    return ok({ items: rows.map(toApiStockSnapshot), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
