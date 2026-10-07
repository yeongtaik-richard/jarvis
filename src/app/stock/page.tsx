/**
 * `/stock` — 테마 보드. **어느 테마가 지금 뜨거운가.**
 *
 * ## 왜 종목 하나에서 테마로 옮겼나
 * 이 화면은 원래 SK하이닉스 한 종목의 대시보드였다. 그런데 한 종목으로는 규칙을
 * 검증할 표본이 모이지 않았다 — 하루 지평이 연 42표본, 일주일 지평은 연 8.5표본이라
 * 30표본까지 각각 8개월·3.5년이 걸렸다. 종목을 늘려 해결하려 했지만 측정해보니
 * 한국 반도체 종목끼리는 일간 수익률 상관이 0.82~0.94였다. 스무 종목을 붙여도
 * 실질 독립 표본은 1.2개다 — **거울을 더 다는 것**이었다.
 *
 * 그래서 예측·검증을 접고 **참고정보를 모아 보여주는 쪽**으로 돌아왔다. 테마 간
 * 상대 강도는 예측하지 않아도 지금 사실로 읽히고, 그게 원래 이 기능의 이름이었다.
 * 하이닉스 화면과 규칙 검증 레인은 `/stock/hynix`·`/stock/horizons`에 그대로 있다.
 *
 * ## 화면 규칙
 * - 정렬은 선택한 창의 상승률 내림차순. 창은 1일·1주·1개월·3개월에서 고른다.
 * - **지수를 목록 안에 섞어 넣는다.** 예전엔 따로 빼고 "나스닥100보다 나은 테마
 *   6/14" 같은 집계를 보여줬는데, 같은 줄에 세우면 그 숫자를 셀 필요가 없다 —
 *   지수 줄 위에 있는 것이 이긴 테마다. 대신 번호는 안 달고 배경만 깐다. 번호를
 *   달면 "지수가 3위"처럼 읽혀 테마 순위에 끼어든 꼴이 된다.
 * - 선과 숫자는 **같은 창**을 본다. 한쪽이 3개월이고 다른 쪽이 1주면, 진짜 데이터인데도
 *   차트가 가짜처럼 보인다 (실제로 그렇게 보였다).
 * - 선은 계열마다 자기 범위로 그려 **모양만** 보여준다. 높이로 크기를 비교하면 축이
 *   달라 거짓말이 되므로, 크기 비교는 옆의 숫자가 한다.
 */

import Link from 'next/link';
import { Header } from '@/app/components/Header';
import {
  BOARD_WINDOWS,
  getThemeBoard,
  getThemeFlows,
  resolveWindow,
  windowLocked,
  type ThemeRow,
} from '@/lib/theme-board-service';
import { moneyMil, won } from './format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 등락 색은 국내 관례 — 빨강이 상승, 파랑이 하락. */
const retClass = (v: number | null): string =>
  v === null
    ? 'text-zinc-400'
    : v > 0
      ? 'text-red-600 dark:text-red-400'
      : v < 0
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-zinc-500';

const pct = (v: number | null): string =>
  v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

/**
 * 선택한 창만 잘라낸다.
 *
 * 예전엔 스파크라인이 **3개월 전체**를 그리면서 옆의 숫자는 선택한 창(1주)이었다.
 * 선과 숫자가 서로 다른 기간을 말하니 "차트가 가짜 같다"는 반응이 나왔는데, 가짜가
 * 아니라 **기간이 어긋난 진짜**였다. 창을 맞추면 선 모양이 곧 그 숫자의 내력이 된다.
 */
function windowed<T extends { date: string }>(points: T[], days: number): T[] {
  const last = points.at(-1);
  if (!last) return [];
  const from = new Date(`${last.date.slice(0, 10)}T00:00:00Z`).getTime() - days * 86400000;
  const out = points.filter(
    (p) => new Date(`${p.date.slice(0, 10)}T00:00:00Z`).getTime() >= from,
  );
  // 창이 너무 좁아 점이 하나뿐이면 직전 점을 하나 끌어와 선이 생기게 한다.
  if (out.length < 2 && points.length >= 2) return points.slice(-2);
  return out;
}

const strokeOf = (up: boolean | null) =>
  up === null ? 'var(--viz-muted)' : up ? 'var(--viz-up)' : 'var(--viz-down)';

/**
 * 접힌 줄에 들어가는 **거친 선**.
 *
 * 창 안의 점을 다섯 개쯤으로 추려 **이어 그린다.** 전부 그리면 72px에 68개가 들어가
 * 점당 1px이라 모양이 아니라 얼룩이 되고, 반대로 점만 찍으면 오르내림의 방향이 안
 * 읽힌다. 몇 개로 줄여 잇는 쪽이 "올랐나 내렸나 중간에 꺾였나"를 가장 빨리 전한다.
 * 정확한 궤적은 펼쳤을 때 전폭 차트가 보여준다.
 */
function MiniLine({ points, up }: { points: { indexed: number }[]; up: boolean | null }) {
  const W = 72;
  const H = 20;
  if (points.length < 2) {
    return <span className="inline-block w-[72px] text-[10px] text-zinc-400">—</span>;
  }
  const N = Math.min(5, points.length);
  const picked = Array.from({ length: N }, (_, i) =>
    points[Math.round((i / (N - 1)) * (points.length - 1))]!.indexed,
  );
  const lo = Math.min(...picked);
  const hi = Math.max(...picked);
  const span = hi - lo || 1;
  const d = picked
    .map((v, i) => {
      const x = (i / (N - 1)) * (W - 4) + 2;
      const y = H - 3 - ((v - lo) / span) * (H - 6);
      return `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <span className="viz inline-block align-middle">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden>
        <path
          d={d}
          fill="none"
          stroke={strokeOf(up)}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/**
 * 펼쳤을 때 패널 맨 위에 깔리는 가로 전체 차트.
 *
 * viewBox + `w-full h-auto`라 컨테이너 폭을 그대로 채운다(클라이언트 측정 없음).
 * 축 눈금은 양 끝 날짜와 고·저만 — 폰에서 격자를 촘촘히 깔면 선보다 격자가 먼저 보인다.
 */
function ThemeChart({
  points,
  up,
  usd,
}: {
  points: { date: string; close: number; indexed: number }[];
  up: boolean | null;
  usd?: boolean;
}) {
  if (points.length < 2) {
    return <div className="text-[11px] text-zinc-400">점이 부족해 차트를 못 그린다</div>;
  }
  const W = 600;
  const H = 120;
  const PAD = 6;
  const vals = points.map((p) => p.close);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * (W - PAD * 2) + PAD;
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const line = points
    .map((p, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(p.close).toFixed(1)}`)
    .join(' ');
  const area = `${line} L ${x(points.length - 1).toFixed(1)} ${H - PAD} L ${x(0).toFixed(1)} ${H - PAD} Z`;
  return (
    <div className="viz">
      <svg
        className="w-full h-auto"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${points[0]!.date}부터 ${points.at(-1)!.date}까지 종가 추이`}
      >
        <path d={area} fill={strokeOf(up)} opacity="0.08" />
        <path
          d={line}
          fill="none"
          stroke={strokeOf(up)}
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-400 tabular-nums">
        <span>{points[0]!.date.slice(5)}</span>
        <span>
          저 {usd ? `$${lo.toFixed(2)}` : lo.toLocaleString('ko-KR')} · 고{' '}
          {usd ? `$${hi.toFixed(2)}` : hi.toLocaleString('ko-KR')}
        </span>
        <span>{points.at(-1)!.date.slice(5)}</span>
      </div>
    </div>
  );
}

function Row({
  rank,
  row,
  flows,
  days,
}: {
  rank: number | null;
  row: ThemeRow;
  flows: { date: string; foreign: number; institution: number; individual: number }[];
  days: number;
}) {
  const { etf } = row;
  const up = row.ret === null ? null : row.ret > 0;
  const win = windowed(row.points, days);
  // 기준선은 번호를 안 달고 배경만 깐다. 번호를 달면 "지수가 3위"처럼 읽혀서, 테마가
  // 아닌 것이 테마 순위에 끼어든 꼴이 된다. 배경은 "여기가 기준선"이라는 눈금 역할만.
  const isBench = etf.kind === 'benchmark';
  return (
    <details
      className={`border-t border-zinc-100 dark:border-zinc-900 first:border-t-0 ${
        isBench ? 'bg-zinc-100/70 dark:bg-zinc-900/60' : ''
      }`}
    >
      <summary className="cursor-pointer select-none py-2.5 flex items-center gap-2 text-sm">
        <span className="w-5 shrink-0 text-xs text-zinc-400 tabular-nums">
          {rank ?? ''}
        </span>
        <span className="min-w-0 flex-1">
          <span className={isBench ? 'text-zinc-600 dark:text-zinc-400' : 'font-medium'}>
            {etf.label}
          </span>
          {isBench && <span className="ml-1.5 text-[10px] text-zinc-400">기준선</span>}
          {etf.held && (
            <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              보유
            </span>
          )}
          {etf.market === 'us' && (
            <span className="ml-1 text-[10px] text-zinc-400">미국</span>
          )}
        </span>
        <MiniLine points={win} up={up} />
        <span className={`w-16 shrink-0 text-right tabular-nums ${retClass(row.ret)}`}>
          {pct(row.ret)}
        </span>
      </summary>

      <div className="pb-3 px-1 space-y-2 text-xs text-zinc-600 dark:text-zinc-400">
        {/* 큰 차트가 패널 맨 위에 온다 — 펼치는 이유가 대개 "모양을 제대로 보려고"다 */}
        <ThemeChart points={win} up={up} usd={etf.currency === 'USD'} />
        <div className="tabular-nums">
          <span className="text-zinc-500">1주 </span>
          <span className={retClass(row.ret1w)}>{pct(row.ret1w)}</span>
          <span className="text-zinc-500"> · 1개월 </span>
          <span className={retClass(row.ret1m)}>{pct(row.ret1m)}</span>
          <span className="text-zinc-500"> · 3개월 </span>
          <span className={retClass(row.ret3m)}>{pct(row.ret3m)}</span>
          {row.last !== null && (
            <>
              <span className="text-zinc-500"> · 종가 </span>
              {/* 해외 상장은 달러다. 원화 포맷을 씌우면 28.46달러가 "28원"이 된다. */}
              {etf.currency === 'USD'
                ? `$${row.last.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                : won(row.last)}
            </>
          )}
        </div>
        <div className="text-zinc-400">
          {etf.name} · {etf.issuer} · {etf.code}
          {etf.overseas && ` · ${etf.overseas.excd}`}
          {/* 선이 짧은 이유를 화면이 스스로 말한다 — 안 적으면 "덜 올랐다"로 읽힌다 */}
          {' · '}
          {row.tradingDays}거래일치
          {row.tradingDays < 40 && <span className="text-amber-600 dark:text-amber-500"> (상장한 지 얼마 안 됨)</span>}
          {!etf.dateChecked && ' · 상장일 미확인'}
        </div>

        {flows.length > 0 ? (
          <div>
            <div className="text-zinc-500 mb-0.5">투자자별 순매수 (백만원, 최근 5일)</div>
            <table className="w-full tabular-nums">
              <thead className="text-zinc-400">
                <tr>
                  <th className="text-left font-normal py-0.5">날짜</th>
                  <th className="text-right font-normal py-0.5">외국인</th>
                  <th className="text-right font-normal py-0.5">기관</th>
                  <th className="text-right font-normal py-0.5">개인</th>
                </tr>
              </thead>
              <tbody>
                {flows.slice(0, 5).map((f) => (
                  <tr key={f.date} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="py-0.5">{f.date.slice(5)}</td>
                    {[f.foreign, f.institution, f.individual].map((v, i) => (
                      <td key={i} className={`py-0.5 text-right ${retClass(v)}`}>
                        {v === 0 ? '보합' : `${v > 0 ? '+' : '−'}${moneyMil(Math.abs(v))}`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-zinc-400">
            수급은 아직 수집 전이다. ETF도 일별 투자자 순매수가 나오는 건 확인했고,
            다음 마감 수집부터 쌓인다. <strong>장중 수급은 ETF에 안 나온다</strong> —
            개별 종목은 되는데 ETF는 응답이 비어 온다(실측 확인).
          </div>
        )}
      </div>
    </details>
  );
}

export default async function ThemeBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  const days = resolveWindow((await searchParams).d);
  const [board, flowMap] = await Promise.all([getThemeBoard(days), getThemeFlows()]);
  const flowsOf = (code: string) => flowMap.get(code) ?? [];

  // 번호는 **테마에만** 매긴다. 기준선은 목록 안에 섞여 있지만 순위의 일원이 아니다.
  let n = 0;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">테마 보드</h1>
          {board.asOf && (
            <span className="text-xs text-zinc-500">{board.asOf} 기준</span>
          )}
        </div>

        {/* 기간 선택. 링크라 서버에서 다시 정렬되고 클라이언트 JS가 필요 없다.
            이력이 모자란 창은 **버튼은 두되 못 누르게** 한다 — 버튼 자체를 숨기면
            "6개월은 원래 없는 기능"으로 보이고, 열어주면 절반에서 끊긴 선이 "그 뒤로
            안 움직였다"처럼 읽힌다. 얼마나 더 모이면 열리는지를 같이 적는다. */}
        <nav className="flex gap-1 text-xs flex-wrap">
          {BOARD_WINDOWS.map((w) => {
            const locked = windowLocked(w, board.spanDays);
            if (locked) {
              return (
                <span
                  key={w.days}
                  className="px-2.5 py-1 rounded border border-dashed border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-700"
                  title={`이력 ${board.spanDays}일 · ${w.minSpan}일부터 열림`}
                >
                  {w.label}
                </span>
              );
            }
            return (
              <Link
                key={w.days}
                href={`/stock?d=${w.days}`}
                className={`px-2.5 py-1 rounded border ${
                  w.days === days
                    ? 'border-zinc-400 bg-zinc-100 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
                }`}
              >
                {w.label}
              </Link>
            );
          })}
          <span className="self-center ml-1 text-zinc-400">상승률 순</span>
        </nav>

        {(() => {
          const next = BOARD_WINDOWS.find((w) => windowLocked(w, board.spanDays));
          return next ? (
            <p className="text-[11px] text-zinc-400 tabular-nums">
              이력 {board.spanDays}일 · <strong>{next.label}</strong>은 {next.minSpan}일부터
              열린다 ({next.minSpan - board.spanDays}일 더). 과거 일봉은 백필로 당겨올 수
              있다 — 분봉과 달리 지난 날짜도 받아진다.
            </p>
          ) : null;
        })()}

        {board.ranked.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            아직 수집된 시세가 없습니다. ETF 수집기(GitHub Actions)가 돌면 표시됩니다.
          </div>
        ) : (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 overflow-hidden">
            {board.ranked.map((r) => {
              const isTheme = r.etf.kind === 'theme';
              if (isTheme && r.ret !== null) n += 1;
              return (
                <Row
                  key={r.etf.key}
                  rank={isTheme && r.ret !== null ? n : null}
                  row={r}
                  flows={flowsOf(r.etf.code)}
                  days={days}
                />
              );
            })}
          </section>
        )}

        <p className="text-[11px] text-zinc-400">
          테마 하나를 대표 ETF 하나로 본다. 회색 줄은 지수(기준선)라 순위 번호를 달지
          않는다 — <strong>그 줄 위에 있는 테마가 지수를 이긴 것</strong>이다. 선은 각자
          자기 범위로 그려 모양만 보여주므로, 테마끼리 크기를 비교할 때는 선 높이가 아니라
          옆의 숫자를 볼 것.
        </p>

        <nav className="flex gap-4 text-xs text-zinc-500">
          <Link href="/stock/hynix" className="hover:underline">
            SK하이닉스
          </Link>
          <Link href="/stock/horizons" className="hover:underline">
            예측 보드
          </Link>
          <Link href="/stock/data" className="hover:underline">
            데이터
          </Link>
        </nav>
      </main>
    </div>
  );
}
