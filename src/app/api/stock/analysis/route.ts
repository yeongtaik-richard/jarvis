import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';
import { CreateStockAnalysisInput, StockAnalysisQuery } from '@/lib/schemas';
import {
  createStockAnalysis,
  searchStockAnalysis,
  toApiStockAnalysis,
} from '@/lib/stock-analysis-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLog(async (req: NextRequest) => {
  // 자동 브리핑 루틴이 쓰는 자리 — 전용 토큰 허용 (src/lib/auth.ts 참고).
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = CreateStockAnalysisInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const row = await createStockAnalysis(parsed.data);
    return ok(toApiStockAnalysis(row), 201);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = StockAnalysisQuery.safeParse(params);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchStockAnalysis(parsed.data);
    return ok({ items: rows.map(toApiStockAnalysis), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
