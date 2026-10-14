import { type NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import { searchVisits, toApiVisit } from '@/lib/place-visit-service';
import { withLog } from '@/lib/request-log';
import { PlaceVisitQuery } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req);
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = PlaceVisitQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchVisits(parsed.data);
    return ok({ items: rows.map(toApiVisit), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
