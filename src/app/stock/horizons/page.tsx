/**
 * `/stock/horizons` — "이 규칙을 믿을 수 있나"에 답하는 페이지. 주 1회 여는 화면이라
 * 밀도를 허용한다. 대신 `/stock`은 한 줄만 남겼다.
 *
 * 규칙 신호 상세·예측 장부·관찰항목 채점이 전부 여기로 왔다. 전에는 셋 다 장중 화면에
 * 있었는데, 셋 다 장중 판단에 쓰이지 않는다 — 규칙 성적은 하루 사이에 바뀌지 않는다.
 */

import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { getHorizonBoard, type HorizonRow } from '@/lib/horizon-board-service';
import { humanSpan } from '@/lib/horizon-board';
import { getStockSignal } from '@/lib/stock-signal-service';
import { getPredictionLedger } from '@/lib/prediction-ledger';
import { predictionStats, searchPredictions, toApiPrediction } from '@/lib/prediction-service';
import { PredictionQuery } from '@/lib/schemas';
import { SignalDetail } from '../SignalDetail';
import { PredictionLedgerCard } from '../Ledger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SYMBOL = '000660';

const PRED_TEXT: Record<string, string> = {
  pending: '대기',
  confirmed: '확인됨',
  refuted: '빗나감',
  expired: '만료',
  unverifiable: '검증 불가',
};
const PRED_BADGE: Record<string, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  confirmed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  refuted: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  expired: 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500',
  unverifiable: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
};

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
        <span className="w-[4.75rem] shrink-0 font-medium">{r.label}</span>
        <span className="w-12 shrink-0 text-xs">
          {r.direction ? (
            <span className={DIR[r.direction].cls}>{DIR[r.direction].word}</span>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </span>
        <span className="min-w-0 flex-1 text-xs text-zinc-500 tabular-nums">
          {r.record && r.record.scored > 0
            ? `${r.record.hits}/${r.record.scored}건 맞음${
                // 기록 수와 독립 결과 수가 다른 레인은 둘 다 적는다 — 155건을
                // 표본 155개로 읽으면 신뢰도를 6배 부풀려 보게 된다.
                r.selfConflict ? ` · ${r.selfConflict.days}일치` : ''
              }`
            : r.status === 'live'
              ? `0/30건 · ${daysToText(r.daysTo30)}`
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
          {humanSpan(r.tradingDays)} 앞을 본다 · 믿을 만한 표본(30건)까지 {daysToText(r.daysTo30)}
        </div>
        {r.status === 'live' && !r.direction && (
          <div className="text-zinc-500">
            지금은 방향이 비어 있다 — 장중에만 판정하고, 장이 닫히면 다음 개장까지 쉰다.
          </div>
        )}
        {/* 측정된 자기모순. 문장이 아니라 **이 레인의 실제 숫자**여야 한다 —
            "이럴 수 있다"는 경고는 읽고 넘기지만, "33일 중 14일"은 안 넘어간다. */}
        {r.selfConflict && r.selfConflict.conflictDays > 0 && r.record && (
          <div className="rounded bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 p-2 tabular-nums">
            이 적중률은 <strong className="font-medium">하루 단위 신뢰도가 아니다.</strong>{' '}
            기록 {r.record.scored}건이 맞히려는 결과는 {r.selfConflict.days}개(하루 1개)뿐이고,
            그중 {r.selfConflict.conflictDays}일(
            {Math.round((r.selfConflict.conflictDays / r.selfConflict.days) * 100)}%)은 시각마다
            방향이 엇갈렸다. 그런 날은 무슨 일이 일어나든 한쪽이 적중·한쪽이 빗나감으로 남아
            적중률을 50%로 끌어당긴다 — 시간대끼리 비교하는 데만 쓸 것.
          </div>
        )}
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
  const [board, signalResult, ledger, predRows, predStats] = await Promise.all([
    getHorizonBoard(SYMBOL),
    getStockSignal(SYMBOL),
    getPredictionLedger(SYMBOL),
    searchPredictions(PredictionQuery.parse({ symbol: SYMBOL, limit: 8 })),
    predictionStats(SYMBOL),
  ]);
  const live = board.rows.filter((r) => r.status === 'live').length;
  const missing = board.rows.filter((r) => r.status !== 'live').length;
  // 이 섹션이 보여주는 목록은 브리핑의 watch 항목이다. 예전 헤더 숫자는 **전체 풀링**이라
  // 분모의 3분의 2가 watch인 52%가 규칙 성적처럼 읽혔다. 목록과 숫자의 모집단을 맞춘다.
  const watchStats = predStats.by_kind.find((k) => k.kind === 'watch') ?? null;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold">예측 보드</h1>
          <p className="text-xs text-zinc-500 mt-1">
            10분 뒤부터 1년 뒤까지 — 각 시점에 대해 지금 무엇을 말할 수 있나 ·{' '}
            <Link href="/stock" className="underline hover:text-zinc-700">
              참고정보로
            </Link>
          </p>
        </div>

        <div className="text-sm text-zinc-500">
          {board.rows.length}개 시점 중 <strong className="text-zinc-700 dark:text-zinc-300">{live}개</strong>를
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
            · 칸을 다 채우지 않는다. 시점마다 재료가 있는지, 검증이 가능한지가 다르고 그 차이를
            숨기면 보드가 거짓말을 시작한다.
          </p>
          <p>
            · <strong>먼 시점은 방향을 내지 않는다.</strong> 한 종목만 추적하면 1년 뒤는 연 1표본이라
            검증에 30년이 걸린다. 대신 지금 확인 가능한 위치(밸류에이션·실적 추세)를 답한다.
          </p>
          <p>
            · 가까운 시점은 분봉이 있어야 채점된다. 지금 {board.minuteDays}일치 쌓였고, 분봉은 당일치만
            받을 수 있어 매일 모아야 한다.
          </p>
        </div>

        <SignalDetail signalResult={signalResult} />

        <PredictionLedgerCard ledger={ledger} />

        {predRows.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                브리핑 관찰항목 채점{' '}
                <span className="font-normal text-zinc-400">규칙 신호 성적이 아니다</span>
              </h2>
              <span className="text-xs text-zinc-400 tabular-nums">
                {watchStats && watchStats.scored > 0
                  ? `적중 ${watchStats.confirmed}/${watchStats.scored} (${Math.round((watchStats.hit_rate ?? 0) * 100)}%)`
                  : '채점 완료 0건'}
                {watchStats && watchStats.pending > 0 ? ` · 대기 ${watchStats.pending}` : ''}
                {watchStats && watchStats.expired > 0 ? ` · 만료 ${watchStats.expired}` : ''}
              </span>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-900">
              {predRows.map(toApiPrediction).map((pr) => (
                <div key={pr.id} className="p-3 flex gap-3 items-baseline">
                  <span
                    className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${PRED_BADGE[pr.status] ?? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}
                  >
                    {PRED_TEXT[pr.status] ?? pr.status}
                  </span>
                  <div className="min-w-0 flex-1 text-sm">
                    {pr.claim}
                    <div className="text-[11px] text-zinc-400 mt-0.5 tabular-nums">
                      {pr.metric}.{pr.field} {pr.comparator}{' '}
                      {pr.threshold.toLocaleString('ko-KR')} @ {pr.target_bucket}
                      {pr.actual_value !== null
                        ? ` → 실측 ${pr.actual_value.toLocaleString('ko-KR')}`
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-400">
              브리핑이 "지켜볼 것"으로 적은 항목을 기계가 채점한 기록이다. 결과가 이미 나온
              뒤에는 등록 자체가 거부된다 — 알고 나서 쓴 예측을 막으려는 것이다. 만든 주체도
              (브리핑 vs 결정론적 규칙) 검증 방식도 달라 규칙 성적과 같이 세지 않는다.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
