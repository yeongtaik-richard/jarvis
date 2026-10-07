import type { ApiStockAnalysis } from '@/lib/stock-analysis-service';
import { agoText, minutesAgo } from './ui';

const CLAIM_LABEL: Record<string, string> = {
  state_summary: '현황 요약',
  anomaly: '이상 신호',
  scenario: '시나리오',
  risk: '리스크',
  validated_directional: '검증된 방향성',
};

function claimBadge(ct: string): string {
  if (ct === 'anomaly') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  if (ct === 'risk') return 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300';
  if (ct === 'scenario') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
  return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
}

const KIND_LABEL: Record<string, string> = {
  pre: '프리마켓',
  intraday: '장중',
  close: '마감',
  ondemand: '온디맨드',
};

/**
 * 루틴 브리핑은 3화면짜리 벽텍스트가 되기 쉽다 — 앞부분만 보이고 나머지는 접는다.
 *
 * 장중 화면(`/stock`)은 이보다 더 짧게 자른다. 브리핑 본문이 `§0 요일·모드:`,
 * `§1~2 데이터 신선도` 같은 **작업 로그**로 시작해서, 14줄을 펴면 페이지의 대부분이
 * 실행 절차 설명이 된다. 장중에 알고 싶은 건 첫 문단(무슨 일이 있었나)이다.
 */
const BRIEFING_PREVIEW_LINES = 14;

export function BriefingCard({
  a,
  now,
  prominent = false,
  previewLines = BRIEFING_PREVIEW_LINES,
}: {
  a: ApiStockAnalysis;
  now: number;
  prominent?: boolean;
  /** 접기 전에 보여줄 줄 수. 장중 화면은 짧게 준다. */
  previewLines?: number;
}) {
  const mins = minutesAgo(a.created_at, now);
  const lines = a.body.split('\n');
  // previewLines=0은 "제목만 보여주고 본문은 전부 접는다". 본문이 §0 요일·모드,
  // §1~2 데이터 신선도 같은 **실행 로그**로 시작해서 앞줄을 잘라 봐야 절차 설명만
  // 나온다. 무슨 일이 있었나는 title 한 줄이 이미 말한다.
  const collapsible = previewLines === 0 || lines.length > previewLines + 4;
  return (
    <div
      className={`rounded-lg border p-4 ${prominent ? 'border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800'}`}
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded ${claimBadge(a.claim_type)}`}>
          {CLAIM_LABEL[a.claim_type] ?? a.claim_type}
        </span>
        <span className="text-xs text-zinc-500">{KIND_LABEL[a.kind] ?? a.kind}</span>
        <span className="text-xs text-zinc-400 ml-auto">{agoText(mins)}</span>
      </div>
      {a.title && <div className="font-medium mb-1">{a.title}</div>}
      {collapsible ? (
        <>
          {previewLines > 0 && (
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {lines.slice(0, previewLines).join('\n')}
            </div>
          )}
          <details>
            <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
              브리핑 전문 보기
            </summary>
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {lines.slice(previewLines).join('\n')}
            </div>
          </details>
        </>
      ) : (
        <div className="text-sm whitespace-pre-wrap leading-relaxed">{a.body}</div>
      )}
      <div className="mt-2 text-[11px] text-zinc-400">
        {a.authored_by} · {a.symbol} · 서술 텍스트(방향은 규칙 신호 레인에서만)
      </div>
    </div>
  );
}
