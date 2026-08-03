import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { TradeDecisionQuery } from '@/lib/schemas';
import { searchTradeDecisions, toApiTradeDecision } from '@/lib/trade-decision-service';
import { won } from '../format';
import { closeDecisionAction, createDecisionAction } from './actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 사람이 한 결정의 기록이다. 색은 /stock과 같은 국내 관례(빨강=매수, 파랑=매도).
const ACTION_LABEL: Record<string, string> = {
  buy: '매수',
  sell: '매도',
  hold: '보유 유지',
  watch: '관망',
  skip: '안 함',
};
const ACTION_BADGE: Record<string, string> = {
  buy: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  sell: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  hold: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  watch: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  skip: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

const inputClass =
  'w-full px-2 py-2 border border-zinc-300 dark:border-zinc-700 rounded bg-transparent text-sm';

function kstDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default async function DecisionsPage() {
  const rows = await searchTradeDecisions(TradeDecisionQuery.parse({ limit: 100 }));
  const items = rows.map(toApiTradeDecision);
  const open = items.filter((d) => d.status === 'open').length;
  const withLesson = items.filter((d) => d.lesson).length;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-xl font-semibold">매매 결정 로그</h1>
          <p className="text-xs text-zinc-500 mt-1">
            내가 실제로 한 결정 → 결과 → 교훈.{' '}
            <span className="text-zinc-400">AI 추천이 아니라 사후 복기용 기록이다.</span>{' '}
            <Link href="/stock" className="underline hover:text-zinc-700">
              참고정보로
            </Link>
          </p>
        </div>

        <form
          action={createDecisionAction}
          className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3"
        >
          <h2 className="font-medium text-sm">새 결정 기록</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="flex flex-col text-xs">
              <span className="text-zinc-500 mb-1">한 일</span>
              {/* 기본 선택 없음 — '매수'가 기본값이면 기록 화면이 방향을 프레이밍한다 */}
              <select name="action" required defaultValue="" className={inputClass}>
                <option value="" disabled>
                  선택…
                </option>
                {Object.entries(ACTION_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs">
              <span className="text-zinc-500 mb-1">가격 (원, 선택)</span>
              <input name="price" inputMode="numeric" className={inputClass} />
            </label>
            <label className="flex flex-col text-xs">
              <span className="text-zinc-500 mb-1">수량 (선택)</span>
              <input name="quantity" inputMode="numeric" className={inputClass} />
            </label>
            <label className="flex flex-col text-xs">
              <span className="text-zinc-500 mb-1">종목</span>
              <input name="symbol" defaultValue="000660" className={inputClass} />
            </label>
          </div>
          <label className="flex flex-col text-xs">
            <span className="text-zinc-500 mb-1">
              왜 그렇게 했나 — 지금 시점의 근거 (나중에 미화하지 말 것)
            </span>
            <textarea name="rationale" required rows={3} className={inputClass} />
          </label>
          <button
            type="submit"
            className="px-3 py-2 rounded bg-zinc-900 text-white dark:bg-white dark:text-black text-sm"
          >
            기록
          </button>
        </form>

        <div className="text-sm text-zinc-500">
          {items.length}건 · 결과 대기 {open}건 · 교훈 남긴 것 {withLesson}건
        </div>

        {items.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            아직 기록이 없습니다. 매매하거나 일부러 안 했을 때 그 순간 남겨두면, 나중에
            무엇이 통했는지 되짚을 수 있어요.
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((d) => (
              <article
                key={d.id}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
              >
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${ACTION_BADGE[d.action] ?? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}
                  >
                    {ACTION_LABEL[d.action] ?? d.action}
                  </span>
                  {d.price !== null && (
                    <span className="text-sm tabular-nums">{won(d.price)}</span>
                  )}
                  {d.quantity !== null && (
                    <span className="text-xs text-zinc-500 tabular-nums">
                      {d.quantity.toLocaleString('ko-KR')}주
                    </span>
                  )}
                  <span className="text-xs text-zinc-400 ml-auto">
                    {kstDateTime(d.decided_at)}
                  </span>
                </div>

                <p className="text-sm whitespace-pre-wrap leading-relaxed">
                  {d.rationale}
                </p>

                {d.status === 'closed' ? (
                  <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-900 space-y-2 text-sm">
                    {d.outcome && (
                      <div>
                        <span className="text-xs text-zinc-500">결과</span>
                        <p className="whitespace-pre-wrap">{d.outcome}</p>
                      </div>
                    )}
                    {d.lesson && (
                      <div>
                        <span className="text-xs text-zinc-500">교훈</span>
                        <p className="whitespace-pre-wrap">{d.lesson}</p>
                      </div>
                    )}
                    {d.outcome_at && (
                      <div className="text-[11px] text-zinc-400">
                        {kstDateTime(d.outcome_at)} 기록
                      </div>
                    )}
                  </div>
                ) : (
                  <details className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-900">
                    <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
                      결과·교훈 남기기
                    </summary>
                    <form
                      action={closeDecisionAction.bind(null, d.id)}
                      className="mt-2 space-y-2"
                    >
                      <label className="flex flex-col text-xs">
                        <span className="text-zinc-500 mb-1">실제로 어떻게 됐나</span>
                        <textarea name="outcome" required rows={2} className={inputClass} />
                      </label>
                      <label className="flex flex-col text-xs">
                        <span className="text-zinc-500 mb-1">
                          다음엔 뭘 다르게 할까 (교훈)
                        </span>
                        <textarea name="lesson" rows={2} className={inputClass} />
                      </label>
                      <button
                        type="submit"
                        className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 text-sm"
                      >
                        저장하고 닫기
                      </button>
                    </form>
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
