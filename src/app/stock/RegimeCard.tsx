/**
 * 국면 카드 — 추세·변동성·수급 라벨.
 *
 * `/stock`에서 내려 `/stock/data`로 옮겼다. 같은 내용을 규칙 신호의 컴포넌트 목록이
 * 더 구체적으로 말하고 있어서(`추세 ▲`, `외국인 수급 ▼`), 장중 화면에 둘 다 두면
 * 같은 얘기를 두 번 읽게 된다.
 */

import type { RegimeResult } from '@/lib/stock-regime-service';

// 추세 색은 국내 관례(빨강=상승, 파랑=하락), 변동성은 상태색(중립→경고).
const TREND_TEXT: Record<string, string> = {
  up: '상승 추세',
  down: '하락 추세',
  sideways: '횡보',
  unknown: '추세 판단 불가',
};
const TREND_BADGE: Record<string, string> = {
  up: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  down: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  sideways: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};
const VOL_TEXT: Record<string, string> = {
  calm: '변동성 낮음',
  normal: '변동성 보통',
  elevated: '변동성 높음',
  extreme: '변동성 극단',
  unknown: '변동성 판단 불가',
};
const VOL_BADGE: Record<string, string> = {
  calm: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  normal: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  elevated: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  extreme: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};
const FLOW_TEXT: Record<string, string> = {
  foreign_buying: '외국인 순매수 지속',
  foreign_selling: '외국인 순매도 지속',
  mixed: '수급 엇갈림',
  unknown: '수급 판단 불가',
};
const FLOW_BADGE: Record<string, string> = {
  foreign_buying: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  foreign_selling: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  mixed: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

export function RegimeCard({ regimeResult }: { regimeResult: RegimeResult }) {
  const { regime, indicators } = regimeResult;
  if (!regime || !indicators) return null;
  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="font-medium">
          국면{' '}
          <span className="text-xs font-normal text-zinc-400">
            규칙 기반 · 최근 {indicators.trading_days}거래일
          </span>
        </h2>
        <span className="text-xs text-zinc-400">기준 {indicators.as_of}</span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded ${TREND_BADGE[regime.trend]}`}>
          {TREND_TEXT[regime.trend]}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded ${VOL_BADGE[regime.volatility]}`}>
          {VOL_TEXT[regime.volatility]}
          {indicators.vol20_percentile !== null
            ? indicators.vol20_percentile >= 99
              ? ' (이력 중 최고)'
              : ` (상위 ${100 - indicators.vol20_percentile}%)`
            : ''}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded ${FLOW_BADGE[regime.flow]}`}>
          {FLOW_TEXT[regime.flow]}
        </span>
      </div>
      <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 tabular-nums">
        {regime.reasons.slice(0, 8).map((r) => (
          <li key={r}>· {r}</li>
        ))}
      </ul>
      {regime.reasons.length > 8 && (
        <details>
          <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
            근거 더 보기 ({regime.reasons.length - 8})
          </summary>
          <ul className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 tabular-nums">
            {regime.reasons.slice(8).map((r) => (
              <li key={r}>· {r}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-[11px] text-zinc-400 pt-1">
        {regime.disclaimer} 임계값은 `src/lib/stock-indicators.ts`에 있다.
      </p>
    </section>
  );
}
