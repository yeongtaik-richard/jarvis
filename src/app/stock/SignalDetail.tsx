/**
 * 규칙 신호 — 한 줄짜리와 상세, 두 벌.
 *
 * ## 왜 둘로 갈랐나
 * 예전엔 `/stock` 한가운데에 342줄짜리 카드 하나가 있었다. 그 카드는 방향을 크게
 * 말하고 **바로 밑에서 그 방향을 믿지 말라고** 했다. 한 카드 안에서 자기를 세우고
 * 자기를 부수니 "이 페이지가 뭘 말하려는 거지?"가 된다.
 *
 * 실측이 그 긴장의 원인이다 — champion은 기저율보다 하루 지평 −18%p, 일주일 지평
 * −44%p다. **기저율에 지는 신호는 장중 폰 화면의 주인공이 될 자격이 없다.** 그래서
 * `/stock`에는 `SignalOneLine` 한 줄만 남기고, 나머지는 주 1회 여는 `/stock/horizons`로
 * 내렸다.
 *
 * ## 화면에서 내려도 검증은 계속된다
 * 신호 기록은 **수집기**가 한다(`docs/stock.md` §규칙 — 마감 수집 성공 후
 * `POST /api/stock/signal`). 렌더링과 무관하므로 배지를 줄여도 표본은 그대로 쌓이고
 * 채점도 그대로 돈다. 강등 비용이 0이다.
 *
 * ## 정직성 규칙은 그대로다
 * `docs/stock.md`가 요구하는 건 "미검증 + 표본 수 없이 신호만 보여주는 경로가 없을
 * 것"이다. 한 줄 안에 미검증 라벨·표본 수·기저율이 전부 들어가므로, 줄이면서 오히려
 * 더 강하게 충족한다 — 예전 배지는 표본 수만 말하고 성적은 말하지 않았다.
 */

import Link from 'next/link';
import type { DirectionalStats, SignalResult } from '@/lib/stock-signal-service';

// 신호 배지. 워딩은 의도적으로 조건 서술형이다 — "매수/매도"는 권고로 읽혀서
// 정직성 제약을 무너뜨린다 (codex 리뷰 반영). 색은 방향 관례(빨강=상방)만 따른다.
const SIGNAL_TEXT: Record<string, string> = {
  buy: '상방 조건 충족',
  sell: '하방 조건 충족',
  watch: '관망',
};
const SIGNAL_BADGE: Record<string, string> = {
  buy: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  sell: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  watch: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

const COMPONENT_LABEL: Record<string, string> = {
  trend: '추세 (이동평균선)',
  flow: '외국인 수급',
  relative_sox: '미국 반도체 지수 대비',
};
const AXIS_LABEL: Record<string, string> = {
  trend: '추세',
  volatility: '변동성',
  flow: '수급',
};
const REGIME_VALUE_LABEL: Record<string, string> = {
  up: '상승',
  down: '하락',
  sideways: '횡보',
  calm: '낮음',
  normal: '보통',
  elevated: '높음',
  extreme: '극단',
  foreign_buying: '외국인 순매수',
  foreign_selling: '외국인 순매도',
  mixed: '엇갈림',
  unknown: '이력 없음',
};
/** 이보다 표본이 적은 슬라이스는 표에 올리지 않는다 — 숫자가 노이즈다. */
const REGIME_MIN_N = 8;

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * 차이 칸은 상태색 — 빨강·파랑은 가격 방향 전용이다.
 *
 * 음수를 zinc-500으로 두면 **"데이터 없음"과 똑같은 회색**이라, 규칙이 기저율에 지고
 * 있다는 사실이 시각적으로 사라진다. 양수만 초록으로 칠하는 건 평가가 아니라 칭찬이다.
 */
const edgeClass = (pp: number | null): string =>
  pp === null
    ? ''
    : pp > 0
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-amber-700 dark:text-amber-500';

const edgeText = (pp: number | null): string =>
  pp === null ? '—' : `${pp > 0 ? '+' : ''}${pp.toFixed(1)}%p`;

/** 이 레인이 기록한 전부 — 게이트 통과율의 분모다. */
const laneTotal = (s: DirectionalStats): number =>
  s.pending + s.scored + s.expired + s.unverifiable;

/** 실전 적중률에서 기저율을 뺀 값(%p). 기저율 없이 적중률만 쓰면 정직성 규칙 ④ 위반. */
function liveEdge(h: SignalResult['horizons'][number]): number | null {
  const base = h.backtest.baseline_up_rate;
  return h.live.hit_rate !== null && base !== null ? (h.live.hit_rate - base) * 100 : null;
}

/**
 * 방향 쏠림 한 줄. **적중률 옆에 반드시 같이 둔다** — 2026-08 하루 레인은 24건이 전부
 * 하방이었는데 "35% 맞음"만 보여서 그게 안 드러났다. 한쪽만 부르는 규칙은 예측이
 * 아니라 상수이고, 그건 적중률이 아니라 이 숫자로만 보인다.
 */
function callBalanceText(calls: { n: number; up: number; down: number; up_share: number | null }) {
  if (calls.n === 0) return null;
  const stuck = calls.up === 0 || calls.down === 0;
  return (
    <span className={stuck ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400'}>
      {' · '}
      상방 {calls.up} / 하방 {calls.down}
      {stuck && ` — 한쪽만 부르고 있다`}
    </span>
  );
}

/**
 * `/stock`에 남는 전부. 방향 + 미검증 + 성적 + 기저율 + 표본 수가 **한 줄**이다.
 *
 * 숫자를 늘려 정직해지려던 게 지난번 실수였다(신뢰도 스트립 2줄 × 5개 수치). 정직성은
 * 숫자의 개수가 아니라 **무엇을 크게 놓느냐**의 문제다.
 */
export function SignalOneLine({ signalResult }: { signalResult: SignalResult }) {
  const s = signalResult.signal;
  if (!s) return null;
  const h = signalResult.horizons[0] ?? null;
  const edge = h ? liveEdge(h) : null;

  return (
    <Link
      href="/stock/horizons"
      className="block rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
    >
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-zinc-500">규칙</span>
        <span className={`px-2 py-0.5 rounded text-xs ${SIGNAL_BADGE[s.signal]}`}>
          {SIGNAL_TEXT[s.signal]}
        </span>
        {/* 미검증 라벨은 신호명과 붙어 있어야 한다 — 떨어뜨리면 권고로 오독된다 */}
        <span className="text-xs text-amber-700 dark:text-amber-500">미검증</span>
        {h && h.live.scored > 0 && (
          <span className="text-xs text-zinc-500 tabular-nums">
            {h.label} {pct(h.live.hit_rate)} vs 기저 {pct(h.backtest.baseline_up_rate)} ·{' '}
            {h.live.scored}건 ·{' '}
            <span className={edgeClass(edge)}>{edgeText(edge)}</span>
          </span>
        )}
        {h && h.live.scored === 0 && (
          <span className="text-xs text-zinc-400">실전 표본 없음</span>
        )}
        <span className="ml-auto text-xs text-zinc-400">성적 자세히 →</span>
      </div>
    </Link>
  );
}

/** `/stock/horizons`가 쓰는 전체. 주 1회 여는 화면이라 밀도를 허용한다. */
export function SignalDetail({ signalResult }: { signalResult: SignalResult }) {
  const s = signalResult.signal;
  if (!s) return null;

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-medium">
          규칙 신호{' '}
          <span className="text-xs font-normal text-zinc-400">하루 뒤 · 일주일 뒤를 본다</span>
        </h2>
        <span className={`text-sm px-2.5 py-1 rounded font-medium ${SIGNAL_BADGE[s.signal]}`}>
          {SIGNAL_TEXT[s.signal]}
        </span>
      </div>

      {/* 지평별 성적. 실전이 먼저·굵게, 인샘플은 접어서 맨 아래.
          예전엔 인샘플이 zinc-800 font-medium, 실전이 zinc-500이라 강조 순서가
          신뢰도와 정반대였다. */}
      <div className="space-y-2">
        {signalResult.horizons.map((h) => {
          const bt = h.backtest;
          const inSample =
            bt.buy.hit_rate !== null && bt.baseline_up_rate !== null
              ? (bt.buy.hit_rate - bt.baseline_up_rate) * 100
              : null;
          const live = liveEdge(h);
          const passed = laneTotal(h.live);
          const total = passed + laneTotal(h.blocked);
          return (
            <div
              key={h.key}
              className="rounded border border-zinc-100 dark:border-zinc-900 p-2.5 text-xs"
            >
              <div className="font-medium">
                {h.label} 뒤에 채점
                <span className="font-normal text-zinc-400"> · {h.trading_days}거래일</span>
                {h.stale && (
                  <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    기준 낡음
                  </span>
                )}
                {h.beyond_known_calendar && (
                  <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    휴장일 달력 범위 밖
                  </span>
                )}
              </div>
              <div className="mt-1 text-zinc-700 dark:text-zinc-300 tabular-nums">
                실제 성적:{' '}
                {h.live.scored > 0 ? (
                  <>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {h.live.scored}건 중 {pct(h.live.hit_rate)} 맞음
                    </span>
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {' · 아무 날이나 샀으면 '}
                      {pct(bt.baseline_up_rate)}
                      {' · 규칙이 보탠 건 '}
                    </span>
                    <span className={`font-medium ${edgeClass(live)}`}>{edgeText(live)}</span>
                  </>
                ) : h.live.pending > 0 ? (
                  `아직 없음 (${h.live.pending}건 채점 대기)`
                ) : (
                  '아직 없음'
                )}
                {callBalanceText(h.live.calls)}
              </div>
              {total > 0 && (
                <div className="mt-0.5 text-zinc-400 tabular-nums">
                  게이트 통과 {passed}/{total} ({Math.round((passed / total) * 100)}%)
                  {(h.blocked.scored > 0 || h.blocked.pending > 0) && (
                    <>
                      {' · 관망으로 막힌 것 '}
                      {h.blocked.scored > 0
                        ? `${h.blocked.scored}건 중 ${pct(h.blocked.hit_rate)} 맞음`
                        : `${h.blocked.pending}건 대기`}
                    </>
                  )}
                </div>
              )}
              {/* 병행 기록 중인 후보 규칙. 현행을 바꾸지 않고 같은 날 같은 조건으로
                  채점받게 해서, 몇 달 뒤 실전 데이터로 고르려는 것이다. */}
              {h.challengers.map((c) => (
                <div key={c.key} className="mt-1 text-zinc-400 tabular-nums">
                  후보 {c.label}:{' '}
                  {c.live.scored > 0
                    ? `${c.live.scored}건 중 ${pct(c.live.hit_rate)} 맞음`
                    : c.live.pending > 0
                      ? `아직 없음 (${c.live.pending}건 대기)`
                      : '아직 없음'}
                  {callBalanceText(c.live.calls)}
                </div>
              ))}
              <details className="mt-1">
                <summary className="text-zinc-400 cursor-pointer">
                  과거에 돌려본 성적 (인샘플 — 규칙을 만든 데이터다)
                </summary>
                <div className="mt-1 text-zinc-500 dark:text-zinc-400 tabular-nums">
                  같은 규칙을 과거에 돌려보면 {pct(bt.buy.hit_rate)} 맞았다 ({bt.buy.n}번 중).
                  아무 날이나 샀으면 {pct(bt.baseline_up_rate)}니까, 규칙이 보탠 건{' '}
                  <span className={edgeClass(inSample)}>{edgeText(inSample)}</span>. {bt.note}
                </div>
              </details>
            </div>
          );
        })}
      </div>

      {/* 오늘 신호의 근거. 검증 숫자 **뒤**에 온다 — 성적을 보기도 전에 근거부터
          보면 규칙에 암묵적 정당성을 먼저 주게 된다. */}
      <details>
        <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
          오늘 신호의 근거
        </summary>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          지표 {s.max_score}개 중 상방 {s.components.filter((c) => c.value > 0).length} · 하방{' '}
          {s.components.filter((c) => c.value < 0).length} · 중립{' '}
          {s.components.filter((c) => c.value === 0).length}
          {s.gated_by_volatility ? ' — 변동성이 워낙 커서 관망으로 내렸다' : ''}
        </div>
        <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 tabular-nums">
          {s.components.map((c) => (
            <li key={c.key}>
              {c.value > 0 ? '▲' : c.value < 0 ? '▼' : '·'} {c.reason}
            </li>
          ))}
        </ul>
      </details>

      {/* 국면·컴포넌트 분해 — 규칙 개선의 작업대. 월 1회 이하로 여는 물건이다. */}
      <details>
        <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
          어떤 장에서 무엇이 잘 맞았나 (규칙 개선용)
        </summary>
        <div className="mt-1 space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-zinc-500">
                <tr>
                  <th className="text-left font-normal py-1">지표</th>
                  <th className="text-right font-normal py-1">표본</th>
                  <th className="text-right font-normal py-1">맞음</th>
                  <th className="text-right font-normal py-1">무작위</th>
                  <th className="text-right font-normal py-1">차이</th>
                </tr>
              </thead>
              <tbody>
                {signalResult.breakdown.components.map((c) => (
                  <tr key={c.component} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="py-1.5">{COMPONENT_LABEL[c.component] ?? c.component}</td>
                    <td className="py-1.5 text-right text-zinc-500">{c.n}</td>
                    <td className="py-1.5 text-right">{pct(c.hit_rate)}</td>
                    <td className="py-1.5 text-right text-zinc-500">{pct(c.baseline_up_rate)}</td>
                    <td className={`py-1.5 text-right font-medium ${edgeClass(c.edge_pp)}`}>
                      {c.edge_pp === null ? '—' : `${c.edge_pp > 0 ? '+' : ''}${c.edge_pp}%p`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-zinc-500">
                <tr>
                  <th className="text-left font-normal py-1">어떤 장에서</th>
                  <th className="text-right font-normal py-1">표본</th>
                  <th className="text-right font-normal py-1">맞음</th>
                  <th className="text-right font-normal py-1">무작위</th>
                  <th className="text-right font-normal py-1">차이</th>
                </tr>
              </thead>
              <tbody>
                {signalResult.breakdown.regimes
                  .filter((r) => r.n >= REGIME_MIN_N && r.value !== 'unknown')
                  .map((r) => (
                    <tr
                      key={`${r.axis}-${r.value}`}
                      className="border-t border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="py-1.5">
                        <span className="text-zinc-400">{AXIS_LABEL[r.axis] ?? r.axis} </span>
                        {REGIME_VALUE_LABEL[r.value] ?? r.value}
                      </td>
                      <td className="py-1.5 text-right text-zinc-500">{r.n}</td>
                      <td className="py-1.5 text-right">{pct(r.hit_rate)}</td>
                      <td className="py-1.5 text-right text-zinc-500">{pct(r.baseline_up_rate)}</td>
                      <td className={`py-1.5 text-right font-medium ${edgeClass(r.edge_pp)}`}>
                        {r.edge_pp === null ? '—' : `${r.edge_pp > 0 ? '+' : ''}${r.edge_pp}%p`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <ul className="text-[11px] text-zinc-400 space-y-1">
            <li>· 닷새 뒤 종가로 채점했고, 관망으로 걸러진 날까지 포함해서 셌다.</li>
            <li>
              · <strong>외국인 수급 줄은 믿지 말 것.</strong> 수급 데이터가 30거래일 분량뿐이라
              표본 열다섯 개가 급락 한 구간에 몰려 있다. 사건 하나를 열다섯 번 센 것에 가깝다.
            </li>
            <li>
              · 표본이 100건을 넘는 줄만 단서로 볼 만하다. 그렇다고 이 표를 보고 바로 규칙을
              고치면 과거에 맞춰 깎는 셈이니, 실제 성적이 쌓인 뒤에 고치는 게 순서다.
            </li>
          </ul>
        </div>
      </details>

      <p className="text-[11px] text-zinc-400">{s.disclaimer}</p>
    </section>
  );
}
