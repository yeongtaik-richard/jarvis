/**
 * 예측 장부 UI — 한 줄 문장이 먼저고, 펼치면 근거가 나온다.
 *
 * 요약 문장을 앞세우는 이유: 숫자 표를 먼저 보여주면 "그래서 맞았다는 거야 틀렸다는
 * 거야"를 사람이 매번 재구성해야 한다. 장부의 값어치는 그 재구성을 대신해주는 데 있다.
 */

import type { LedgerEntry, PredictionLedger, RunningRecord } from '@/lib/prediction-ledger';
import { won } from './format';

const DIR_WORD: Record<string, string> = { buy: '오르는 쪽', sell: '내리는 쪽' };
const COMPONENT_LABEL: Record<string, string> = {
  trend: '추세',
  flow: '외국인 수급',
  relative_sox: '미국 반도체 대비',
};
/** payload에 영문 코드가 들어 있어도 화면엔 한글만 나가게 한다. */
const VOL_WORD: Record<string, string> = {
  calm: '변동성이 낮은 구간',
  normal: '변동성이 보통인 구간',
  elevated: '변동성이 높은 구간',
  extreme: '변동성이 극단적인 구간',
  unknown: '변동성 판단 불가',
};

/** 월/일 (요일). 장부는 "언제"가 주어라 날짜를 짧고 읽기 쉽게 쓴다. */
function md(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const w = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${w})`;
}

const VERDICT_BADGE: Record<string, string> = {
  confirmed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  refuted: 'bg-zinc-300 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  expired: 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500',
  unverifiable: 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500',
};
const VERDICT_WORD: Record<string, string> = {
  confirmed: '적중',
  refuted: '빗나감',
  pending: '대기',
  expired: '만료',
  unverifiable: '검증 불가',
};

/** 한 건을 사람이 읽는 한 문장으로. */
/**
 * 한 건을 한 문장으로. 괄호 주석을 문장 중간에 끼우면 읽는 흐름이 끊겨서,
 * 게이트 여부는 문장에서 빼고 별도 배지로 뺐다.
 */
function sentence(e: LedgerEntry): string {
  const dir = DIR_WORD[e.direction] ?? e.direction;
  const from = `${md(e.as_of)} 마감 기준 "${dir}"`;
  if (e.status === 'pending') return `${from} → ${md(e.target)} 종가로 판가름`;
  if (e.status === 'expired') {
    return `${from} → ${md(e.target)} 종가가 안 들어와서 채점 못 했다`;
  }
  if (e.status === 'unverifiable') {
    return `${from} → ${md(e.target)} 데이터로는 채점할 수 없었다`;
  }
  if (e.status === 'confirmed' || e.status === 'refuted') {
    const moved = e.change_pct === null ? '' : ` (${e.change_pct >= 0 ? '+' : ''}${e.change_pct}%)`;
    const verb = e.status === 'confirmed' ? '말한 대로 갔다' : '반대로 갔다';
    return `${from} → ${md(e.target)} ${verb}${moved}`;
  }
  return `${from} → ${md(e.target)} ${VERDICT_WORD[e.status] ?? e.status}`;
}

function Row({ e }: { e: LedgerEntry }) {
  return (
    <details className="border-t border-zinc-100 dark:border-zinc-900 first:border-t-0">
      <summary className="cursor-pointer select-none py-2.5 flex items-baseline gap-2 text-sm">
        <span
          className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${VERDICT_BADGE[e.status] ?? VERDICT_BADGE.pending}`}
        >
          {VERDICT_WORD[e.status] ?? e.status}
        </span>
        <span className={`min-w-0 flex-1 ${e.passed ? '' : 'text-zinc-500'}`}>
          {sentence(e)}
          {!e.passed && (
            <>
              {' '}
              <span className="whitespace-nowrap text-[10px] px-1 py-0.5 rounded bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 align-middle">
                관망이라 참고만
              </span>
            </>
          )}
        </span>
        <span className="shrink-0 text-[11px] text-zinc-400">{e.horizon_label} 뒤</span>
      </summary>
      <dl className="pb-3 pl-1 space-y-1 text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
        <div className="flex gap-2">
          <dt className="text-zinc-500 w-24 shrink-0">기준 종가</dt>
          <dd>
            {won(e.reference)} <span className="text-zinc-400">({e.as_of} 확정)</span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-zinc-500 w-24 shrink-0">채점할 종가</dt>
          <dd>
            {e.actual === null ? (
              <span className="text-zinc-400">아직 없음 — {e.target} 마감 후</span>
            ) : (
              <>
                {won(e.actual)}{' '}
                <span className="text-zinc-400">
                  ({e.change_pct !== null && e.change_pct >= 0 ? '+' : ''}
                  {e.change_pct}%)
                </span>
              </>
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-zinc-500 w-24 shrink-0">그때 상황</dt>
          <dd>
            {VOL_WORD[e.volatility ?? ''] ?? '변동성 정보 없음'}
            {e.gated && <span className="text-zinc-400">이라 관망으로 내렸다</span>}
          </dd>
        </div>
        {Object.keys(e.components).length > 0 && (
          <div className="flex gap-2">
            <dt className="text-zinc-500 w-24 shrink-0">근거 지표</dt>
            {/* 값 0을 '·'로 찍으면 구분자 '·'와 붙어 "수급 · ·"처럼 보였다 */}
            <dd>
              {Object.entries(e.components)
                .map(
                  ([k, v]) =>
                    `${COMPONENT_LABEL[k] ?? k} ${v > 0 ? '상방' : v < 0 ? '하방' : '중립'}`,
                )
                .join(' · ')}
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}

function RecordLine({ label, r, muted }: { label: string; r: RunningRecord; muted?: boolean }) {
  if (r.scored === 0) return null;
  const streakText =
    r.streak >= 2
      ? ` · ${r.streak}연속 적중`
      : r.streak <= -2
        ? ` · ${-r.streak}연속 빗나감`
        : '';
  return (
    <span className={`tabular-nums ${muted ? 'text-zinc-400' : ''}`}>
      {label} {r.scored}건 중 {r.hits}건 맞음 ({Math.round((r.hit_rate ?? 0) * 100)}%)
      {streakText}
    </span>
  );
}

export function PredictionLedgerCard({ ledger }: { ledger: PredictionLedger }) {
  const { due, settled, open, unscored, running, running_blocked } = ledger;
  if (due.length === 0 && settled.length === 0 && open.length === 0 && unscored.length === 0) {
    return null;
  }

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="font-medium">예측 장부</h2>
        <span className="text-xs text-zinc-400">뭐라 했고, 맞았나</span>
        <span className="ml-auto text-xs">
          {running.scored > 0 ? (
            <RecordLine label="" r={running} />
          ) : (
            <span className="text-zinc-400">아직 채점된 게 없다</span>
          )}
        </span>
      </div>

      {due.length > 0 && (
        <div>
          <div className="text-[11px] text-zinc-400 mb-0.5">오늘 판가름난다</div>
          {due.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <div>
          <div className="text-[11px] text-zinc-400 mb-0.5">결과가 나온 것</div>
          {settled.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </div>
      )}

      {open.length > 0 && (
        <div>
          <div className="text-[11px] text-zinc-400 mb-0.5">걸려 있는 것</div>
          {open.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </div>
      )}

      {unscored.length > 0 && (
        <div>
          {/* 채점 실패는 숨기면 안 된다 — 표본이 왜 안 쌓이는지가 여기 있다 */}
          <div className="text-[11px] text-zinc-400 mb-0.5">채점하지 못한 것</div>
          {unscored.map((e) => (
            <Row key={e.id} e={e} />
          ))}
        </div>
      )}

      {running_blocked.scored > 0 && (
        <div className="text-[11px]">
          <RecordLine label="관망이라 넘긴 것" r={running_blocked} muted />
          <span className="text-zinc-400">
            {' '}
            — 이쪽이 더 잘 맞으면 관망 기준이 틀렸다는 뜻이라 같이 세어둔다.
          </span>
        </div>
      )}

      <p className="text-[11px] text-zinc-400">
        실제로 기록된 것만 세운다. 과거를 되돌려 계산해 채우면 결과를 알고 쓴 예측이 섞여서
        장부가 의미를 잃는다. 그래서 처음엔 비어 있고, 매 거래일 마감마다 한 줄씩 늘어난다.
      </p>
    </section>
  );
}
