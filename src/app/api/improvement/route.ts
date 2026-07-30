import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import {
  createImprovement,
  searchImprovements,
  toApiImprovement,
} from '@/lib/improvement-service';
import { withLog } from '@/lib/request-log';
import { CreateImprovementInput, ImprovementSearchQuery } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLog(async (req: NextRequest) => {
  // 브리핑 루틴이 "브리핑 품질/데이터 한계"를 스스로 남길 수 있도록 전용 토큰도 허용한다.
  // append-only 노트라 파급이 작고, 읽기(GET)는 여전히 전권 토큰만 된다.
  const authError = checkBearer(req, { also: 'briefing' });
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
});

export const GET = withLog(async (req: NextRequest) => {
  // 브리핑 루틴도 읽을 수 있어야 이미 올린 노트를 또 올리지 않는다 (중복 방지).
  const authError = checkBearer(req, { also: 'briefing' });
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
});
