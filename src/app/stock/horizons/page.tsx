import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { getHorizonBoard, type HorizonRow } from '@/lib/horizon-board-service';
import { humanSpan } from '@/lib/horizon-board';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUS_LABEL: Record<string, string> = {
  no_data: '재료 없음',
  not_built: '아직 안 만듦',
  live: '예측·채점 중',
  position_only: '방향 안 냄',
};
const STATUS_BADGE: Record<string, string> = {
  no_data: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  not_built: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  live: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  position_only: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
};
// 방향 색은 국내 관례 — 빨강=상승, 파랑=하락.
const DIR = {
  up: { word: '오른다', cls: 'text-red-600 dark:text-red-400' },
  down: { word: '내린다', cls: 'text-blue-600 dark:text-blue-400' },
};

function daysToText(d: number): string {
  if (d <= 30) return `${d}거래일`;
  if (d < 250) return `약 ${Math.round(d / 20)}개월`;
  return `약 ${(d / 250).toFixed(d % 250 === 0 ? 0 : 1)}년`;
}

function Row({ r }: { r: HorizonRow }) {
  return (
    <details className="border-t border-zinc-100 dark:border-zinc-900 first:border-t-0">
      <summary className="cursor-pointer select-none py-3 flex items-baseline gap-2 text-sm">
        <span className="w-[5.5rem] shrink-0 font-medium">{r.label}</span>
        <span className="w-14 shrink-0">
          {r.direction ? (
            <span className={DIR[r.direction].cls}>{DIR[r.direction].word}</span>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </span>
        <span className="min-w-0 flex-1 text-zinc-500 tabular-nums">
          {r.record && r.record.scored > 0
            ? `${r.record.scored}건 중 ${r.record.hits}건 맞음`
            : r.status === 'live'
              ? '채점된 것 없음'
              : r.status === 'position_only' && r.position
                ? (r.position.facets[r.key]?.short ?? r.position.headline)
                : ''}
        </span>
        <span
          className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${STATUS_BADGE[r.status]}`}
        >
          {STATUS_LABEL[r.status]}
        </span>
      </summary>
      <div className="pb-3 pl-1 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <div>
          <span className="text-zinc-500">필요한 재료 </span>
          {r.needs}
        </div>
        {r.target && (
          <div>
            <span className="text-zinc-500">채점 대상 </span>
            {r.target}
          </div>
        )}
        <div>
          <span className="text-zinc-500">검증 </span>
          지평 {humanSpan(r.tradingDays)} · 독립 표본 30개까지 {daysToText(r.daysTo30)}
        </div>
        {r.note && <div className="text-zinc-500">{r.note}</div>}
        {r.position && (
          <div className="pt-1 space-y-1">
            <div>{r.position.facets[r.key]?.long ?? r.position.headline}</div>
            <div className="text-zinc-500 tabular-nums">
              {r.position.earnings?.points
                .map((q) => `${q.period} ROE ${q.roe}%`)
                .join(' · ')}
            </div>
            {r.position.caveats.map((c) => (
              <div key={c} className="text-zinc-400">
                · {c}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export default async function HorizonsPage() {
  const board = await getHorizonBoard('000660');
  const live = board.rows.filter((r) => r.status === 'live').length;
  const missing = board.rows.filter((r) => r.status !== 'live').length;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold">지평 보드</h1>
          <p className="text-xs text-zinc-500 mt-1">
            10분 뒤부터 1년 뒤까지, 각 시점에 대해 지금 무엇을 말할 수 있나 ·{' '}
            <Link href="/stock" className="underline hover:text-zinc-700">
              참고정보로
            </Link>
          </p>
        </div>

        <div className="text-sm text-zinc-500">
          {board.rows.length}개 지평 중 <strong className="text-zinc-700 dark:text-zinc-300">{live}개</strong>가
          예측·채점 중 · {missing}개는 아직 못 한다
          {board.asOf && <span className="text-zinc-400"> · 기준 {board.asOf} 마감</span>}
        </div>

        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-4">
          {board.rows.map((r) => (
            <Row key={r.key} r={r} />
          ))}
        </section>

        {/* 빈칸이 많은 게 정상이라는 걸 화면이 스스로 말해야 한다 */}
        <div className="text-[11px] text-zinc-400 space-y-1">
          <p>
            · 칸을 다 채우지 않는다. 지평마다 재료가 있는지, 검증이 가능한지가 다르고 그 차이를
            숨기면 보드가 거짓말을 시작한다.
          </p>
          <p>
            · <strong>긴 지평은 방향을 내지 않는다.</strong> 한 종목만 추적하면 1년 지평은 연 1표본이라
            검증에 30년이 걸린다. 대신 지금 확인 가능한 위치(밸류에이션·실적 추세)를 답한다.
          </p>
          <p>
            · 짧은 지평은 분봉이 있어야 채점된다. 지금 {board.minuteDays}일치 쌓였고, 분봉은 당일치만
            받을 수 있어 매일 모아야 한다.
          </p>
        </div>
      </main>
    </div>
  );
}
