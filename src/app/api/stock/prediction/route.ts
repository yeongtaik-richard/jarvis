import type { NextRequest } from 'next/server';
import { checkBearer } from '@/lib/auth';
import { HttpError } from '@/lib/errors';
import { fromZod, jsonError, ok } from '@/lib/http';
import {
  createPrediction,
  searchPredictions,
  toApiPrediction,
} from '@/lib/prediction-service';
import { withLog } from '@/lib/request-log';
import { CreatePredictionInput, PredictionQuery } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 반증 가능한 관찰 조건을 등록한다. 방향성 '추천'이 아니라 **채점될 기록**이다 —
 * 대상 버킷의 데이터가 이미 있으면 409 (결과가 나온 뒤의 등록은 예측이 아니다).
 */
export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const parsed = CreatePredictionInput.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const row = await createPrediction(parsed.data);
    return ok(toApiPrediction(row), 201);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail);
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});

/** 목록 조회. **조회가 곧 채점이다** — pending 중 데이터가 도착한 것은 이 시점에 정산된다. */
export const GET = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = PredictionQuery.safeParse({ symbol: '000660', ...params });
  if (!parsed.success) return fromZod(parsed.error);

  try {
    const rows = await searchPredictions(parsed.data);
    return ok({ items: rows.map(toApiPrediction), count: rows.length });
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
