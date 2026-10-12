import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { collectorRuns, stockSnapshots } from '@/db/schema';
import { checkBearer } from '@/lib/auth';
import { fromZod, jsonError, ok } from '@/lib/http';
import { withLog } from '@/lib/request-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPO = process.env.GITHUB_REPO ?? 'yeongtaik-richard/jarvis';
const WORKFLOW = 'collect-stock.yml';
/**
 * 장중에는 ETF 보드도 같이 깨운다.
 *
 * ETF 수집기는 GitHub cron에만 걸려 있었는데, 그 cron은 best-effort라 하루 일곱 번
 * 예정 중 **한두 번만 떴다.** 하이닉스 쪽은 브리핑 루틴이 이 엔드포인트로 매시간
 * 깨워줘서 멀쩡했고(`collect-stock.yml` 주석: "the reliable path"), ETF만 그 경로
 * 밖에 있었던 것이다. 같은 시간대에 같이 필요한 데이터라 한 번에 깨우면 된다 —
 * 루틴 프롬프트는 건드리지 않아도 된다.
 */
const ETF_WORKFLOW = 'collect-etf.yml';

const Body = z.object({
  kind: z.enum(['intraday', 'close', 'premarket']).default('intraday'),
  symbol: z.string().min(1).max(20).default('000660'),
});

/**
 * 수집 워크플로를 **지금** 시작시킨다 (GitHub workflow_dispatch).
 *
 * 존재 이유: GitHub cron은 1~2시간 늦게 발화하는 게 정상이라, 매시 브리핑 루틴이
 * "데이터 지연"으로 연쇄 스킵된다. dispatch는 수 초 안에 시작되므로(관측 기준),
 * 루틴이 이 엔드포인트를 부르고 ~1분 폴링하면 신선한 데이터로 브리핑할 수 있다.
 *
 * 여기엔 GitHub PAT만 필요하다 — **KIS 키는 여전히 GitHub Secrets에만 있다.**
 * PAT는 fine-grained(이 레포 Actions write 한정)로 만들어 `GITHUB_DISPATCH_TOKEN`에
 * 넣는다. 미설정이면 503 — 루틴은 그 경우 기존 스킵 규칙으로 후퇴한다.
 *
 * 남발 방지 두 겹:
 * - intraday 요청인데 최신 intraday_price가 10분 이내면 dispatch 없이 fresh 반환.
 * - 3분 이내에 시작된 수집 실행이 있으면 already_running 반환.
 */
export const POST = withLog(async (req: NextRequest) => {
  const authError = checkBearer(req, { also: 'briefing' });
  if (authError) return authError;

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return jsonError(503, 'dispatch_unconfigured', {
      detail: 'GITHUB_DISPATCH_TOKEN이 Vercel 환경변수에 없다',
    });
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    /* 빈 바디 허용 — 기본값 사용 */
  }
  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) return fromZod(parsed.error);
  const { kind, symbol } = parsed.data;

  try {
    if (kind === 'intraday') {
      const [latest] = await db
        .select({ asOfAt: stockSnapshots.asOfAt })
        .from(stockSnapshots)
        .where(
          and(eq(stockSnapshots.symbol, symbol), eq(stockSnapshots.metric, 'intraday_price')),
        )
        .orderBy(desc(stockSnapshots.bucketKey))
        .limit(1);
      if (latest?.asOfAt && Date.now() - latest.asOfAt.getTime() < 10 * 60_000) {
        return ok({ skipped: 'fresh', as_of_at: latest.asOfAt.toISOString() });
      }
    }

    const [running] = await db
      .select({ id: collectorRuns.id, startedAt: collectorRuns.startedAt })
      .from(collectorRuns)
      .where(gte(collectorRuns.startedAt, sql`now() - interval '3 minutes'`))
      .orderBy(desc(collectorRuns.startedAt))
      .limit(1);
    if (running) {
      return ok({ skipped: 'already_running', run_id: running.id });
    }

    const dispatch = async (workflow: string, inputs: Record<string, string>) =>
      fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'master', inputs }),
      });

    const res = await dispatch(WORKFLOW, { run_kind: kind });
    if (res.status !== 204) {
      const text = (await res.text()).slice(0, 200);
      console.error(`dispatch failed: ${res.status} ${text}`);
      return jsonError(502, 'dispatch_failed', { status: res.status, detail: text });
    }

    // ETF는 **실패해도 응답을 깎지 않는다.** 이 엔드포인트의 호출자(브리핑 루틴)가
    // 기다리는 건 하이닉스 스냅샷이라, 보드 수집이 안 떴다고 루틴을 멈추게 할 이유가 없다.
    let etf: 'dispatched' | 'skipped' | 'failed' = 'skipped';
    if (kind === 'intraday') {
      try {
        const r = await dispatch(ETF_WORKFLOW, { mode: 'intraday' });
        etf = r.status === 204 ? 'dispatched' : 'failed';
        if (r.status !== 204) {
          console.error(`etf dispatch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
        }
      } catch (e) {
        etf = 'failed';
        console.error('etf dispatch error', e);
      }
    }

    // 202: 시작은 시켰고 완료는 보장하지 않는다. 호출자가 스냅샷 as_of_at을 폴링할 것.
    return ok({ dispatched: true, kind, etf }, 202);
  } catch (e) {
    console.error(e);
    return jsonError(500, 'internal_error');
  }
});
