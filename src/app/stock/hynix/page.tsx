/**
 * `/stock` — 장중에 폰으로 3초 보는 화면.
 *
 * ## 이 페이지가 답하는 질문은 하나다
 * **"지금 SK하이닉스에 무슨 일이 일어나고 있나."** 그 밖의 것은 전부 다른 페이지로
 * 갔다. 이전 버전은 한 스크롤에 여섯 가지 사용 모드를 섞어놨었다 — 하루 수십 번 보는
 * 가격과, 월 1회 이하로 여는 규칙 개선 작업대가 같은 페이지에 있었다. **빈도가 100배
 * 차이 나는 것들이 같은 스크롤을 공유하면**, 매번 들어올 때마다 모든 비용을 다 치른다.
 *
 * | 페이지 | 질문 | 주기 |
 * |---|---|---|
 * | `/stock` | 지금 무슨 일이 | 하루 수십 번 |
 * | `/stock/horizons` | 규칙을 믿을 수 있나 | 주 1회 |
 * | `/stock/data` | 이 숫자 어디서 났나 | 장애 때만 |
 *
 * ## 규칙 신호가 한 줄인 이유
 * 예전엔 342줄짜리 카드가 방향을 크게 말하고 바로 밑에서 그 방향을 믿지 말라고 했다.
 * 실측이 그 긴장의 원인이다 — champion이 기저율보다 하루 −18%p, 일주일 −44%p다.
 * 기저율에 지는 신호는 장중 화면의 주인공이 될 자격이 없다. 자세한 내용은
 * `SignalDetail.tsx` 상단 주석에 있다.
 *
 * ## 설명문을 지운 이유
 * 사용자가 한 명이고 이미 쉰 번 읽었다. 일회성 정보를 매 방문 비용으로 바꿔놓은
 * 것이었다. 정직성 규칙은 *무엇을 주장할 수 있나*를 제약하지, *무엇을 매번 설명해야
 * 하나*를 요구하지 않는다. 지워도 거짓 주장이 생기지 않는다.
 */

import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { getCollectorHealth } from '@/lib/collector-run-service';
import { searchMarketEvents, toApiMarketEvent } from '@/lib/market-event-service';
import { getStockSignal } from '@/lib/stock-signal-service';
import { computeIntradayRead, type IntradayBucket } from '@/lib/stock-intraday-read';
import { MarketEventQuery, StockAnalysisQuery, StockSnapshotQuery } from '@/lib/schemas';
import { searchStockAnalysis, toApiStockAnalysis } from '@/lib/stock-analysis-service';
import {
  getStockHistory,
  searchStockSnapshots,
  toApiStockSnapshot,
} from '@/lib/stock-service';
import { won } from '../format';
import { BriefingCard } from '../BriefingCard';
import { SignalOneLine } from '../SignalDetail';
import {
  agoText,
  freshnessBadge,
  isMarketHoursKst,
  kstTime,
  minutesAgo,
  payloadNum,
  toneClass,
} from '../ui';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 장중 화면이 감당할 만한 건수. 더 주면 스크롤이 길어지고, 덜 주면 놓친다. */
const EVENT_LIMIT = 5;

export default async function StockDashboardPage() {
  const rows = await searchStockSnapshots(StockSnapshotQuery.parse({ latest: true, limit: 100 }));
  const items = rows.map(toApiStockSnapshot);
  const symbol = items[0]?.symbol ?? '000660';

  const [ohlcvRows, flowRows, intradayRows, health, eventRows, analysisRows, signalResult] =
    await Promise.all([
      getStockHistory(symbol, 'daily_ohlcv', 3),
      getStockHistory(symbol, 'investor_flow', 1),
      getStockHistory(symbol, 'intraday_price', 14),
      getCollectorHealth(symbol),
      searchMarketEvents(MarketEventQuery.parse({ symbol, limit: EVENT_LIMIT })),
      searchStockAnalysis(StockAnalysisQuery.parse({ limit: 1 })),
      getStockSignal(symbol),
    ]);

  const events = eventRows.map(toApiMarketEvent);
  const analyses = analysisRows.map(toApiStockAnalysis);
  const closePoints = ohlcvRows
    .map((r) => ({ date: r.bucketKey, close: payloadNum(r.payload, 'close') }))
    .filter((p) => Number.isFinite(p.close));

  const now = Date.now();
  const marketOpen = isMarketHoursKst(now);
  const todayKst = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
  const lastCaptured = items.reduce<string | null>(
    (max, i) => (max && max >= i.captured_at ? max : i.captured_at),
    null,
  );

  // ── 히어로. 장중 스냅샷이 오늘 것일 때만 장중 가격을 쓰고, 아니면 최근 마감 종가.
  const intradaySnap = items.find((i) => i.metric === 'intraday_price');
  const intradayIsToday =
    intradaySnap?.as_of_at != null &&
    new Date(new Date(intradaySnap.as_of_at).getTime() + 9 * 3_600_000)
      .toISOString()
      .slice(0, 10) === todayKst;
  // 오늘 일봉이 확정됐으면 **그게 정답이다.** 장중 스냅샷은 마감 전 마지막 관측일 뿐이라,
  // 확정 후에도 그걸 보여주면 종가와 다른 값이 첫 화면에 남는다 (2026-08-04: 확정 종가
  // 1,577,000인데 히어로는 14:51의 1,558,000을 띄웠다).
  const settledToday = closePoints[closePoints.length - 1]?.date === todayKst;
  let hero: { price: number; rate: number | null; label: string } | null = null;
  if (!settledToday && intradayIsToday && intradaySnap) {
    const p = intradaySnap.payload as Record<string, unknown>;
    const price = Number(p.price);
    const rate = Number(p.change_rate);
    if (Number.isFinite(price)) {
      hero = {
        price,
        rate: Number.isFinite(rate) ? rate : null,
        // 오늘 장중 스냅샷이어도 지금이 장중이라는 뜻은 아니다 — 15:30 이후엔
        // "장중"이 거짓이고, 종가 수집(18:43) 전까지는 확정 전 값이다.
        label: marketOpen
          ? `장중 · ${kstTime(intradaySnap.as_of_at)} 기준`
          : `${kstTime(intradaySnap.as_of_at)} 기준 · 종가 확정 전`,
      };
    }
  } else if (closePoints.length >= 1) {
    const last = closePoints[closePoints.length - 1]!;
    const prev = closePoints[closePoints.length - 2];
    hero = {
      price: last.close,
      rate: prev ? ((last.close - prev.close) / prev.close) * 100 : null,
      label: `${last.date} 마감`,
    };
  }

  // ── 남은 시간 읽기. 장이 열려 있을 때만 — 장 끝난 뒤 "남은 시간"은 말이 안 된다.
  const todayBuckets: IntradayBucket[] = marketOpen
    ? intradayRows
        .filter((r) => r.bucketKey.startsWith(todayKst))
        .map((r) => {
          const p = r.payload as Record<string, unknown>;
          const num = (k: string) => {
            const v = Number(p[k]);
            return Number.isFinite(v) ? v : null;
          };
          return {
            bucketKey: r.bucketKey,
            price: num('price') ?? NaN,
            changeRate: num('change_rate'),
            open: num('open'),
            high: num('high'),
            low: num('low'),
            programNetQty: num('program_net_qty'),
            foreignHoldingDeltaQty: num('foreign_holding_delta_qty') ?? num('foreign_net_qty'),
          };
        })
        .filter((b) => Number.isFinite(b.price))
    : [];
  // 오늘 장중 수급은 굳어 있을 때가 있어서, 확정된 어제 방향을 같이 재료로 쓴다.
  const prevFlowRow = flowRows[flowRows.length - 1];
  const prevFlowSum = prevFlowRow
    ? payloadNum(prevFlowRow.payload, 'foreign_net') +
      payloadNum(prevFlowRow.payload, 'institution_net')
    : NaN;
  const intradayRead = todayBuckets.length
    ? computeIntradayRead(todayBuckets, Number.isFinite(prevFlowSum) ? prevFlowSum : null)
    : null;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">SK하이닉스</h1>
          <span className="text-xs text-zinc-500">참고정보 · 주문 기능 없음</span>
        </div>

        {/* 수집이 멈췄으면 아래 모든 값이 낡은 것이므로 맨 위에 둔다. 평소엔 안 뜬다. */}
        {health.missed && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-3 text-sm">
            <div className="font-medium text-amber-900 dark:text-amber-200">
              마감 수집이 예정 시각까지 성공하지 못했습니다
            </div>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
              예정 {kstTime(health.expected_close_run_at)} · 마지막 성공{' '}
              {health.last_ok_run
                ? `${kstTime(health.last_ok_run.finished_at ?? health.last_ok_run.started_at)} (${Math.round(health.hours_since_ok ?? 0)}시간 전)`
                : '없음'}
              . 휴장일은 계산에서 이미 뺐으니, 이 경고는 실제로 수집이 안 된 것입니다.{' '}
              <Link href="/stock/data" className="underline">
                데이터 보기
              </Link>
            </p>
          </div>
        )}

        {/* ① 가격 — 장중에 반복해서 확인하는 첫 질문 */}
        {hero && (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <div className="flex items-baseline gap-3 flex-wrap">
              {/* 히어로 숫자는 비례 숫자 그대로 — tabular-nums는 큰 숫자를 헐겁게 만든다 */}
              <span className="text-3xl font-semibold">{won(hero.price)}</span>
              {hero.rate !== null && (
                <span
                  className={`text-lg font-medium ${hero.rate >= 0 ? toneClass.pos : toneClass.neg}`}
                >
                  {hero.rate >= 0 ? '+' : ''}
                  {hero.rate.toFixed(2)}%
                </span>
              )}
              <span className="text-xs text-zinc-400">{hero.label}</span>
              {lastCaptured && (
                <span
                  className={`ml-auto shrink-0 text-xs px-2 py-0.5 rounded ${freshnessBadge(minutesAgo(lastCaptured, now), marketOpen)}`}
                >
                  {agoText(minutesAgo(lastCaptured, now))}
                </span>
              )}
            </div>

            {/* ② 장중 읽기 — 장중에만. 설명문은 뺐다(매번 읽을 글이 아니다). */}
            {intradayRead && (
              <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-900">
                <div className="text-sm">{intradayRead.headline}</div>
                <div className="mt-1 text-[11px] text-zinc-400 tabular-nums">
                  {intradayRead.factors.map((f) => f.text).join(' · ')}
                </div>
                {intradayRead.caveats.length > 0 && (
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    믿기 어려운 점: {intradayRead.caveats.join(' · ')}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ③ 공시·뉴스 — 장중 3순위 질문인데 예전엔 열두 번째였다. 위로 올렸다. */}
        {events.length > 0 && (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-900">
            {events.map((e) => (
              <div key={e.id} className="p-3 flex gap-3 items-baseline">
                <span
                  className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded ${
                    e.source === 'dart'
                      ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-black'
                      : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                  }`}
                >
                  {e.source === 'dart' ? '공시' : e.category === 'macro' ? '매크로' : '뉴스'}
                </span>
                <div className="min-w-0 flex-1">
                  {e.url ? (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm hover:underline"
                    >
                      {e.title}
                    </a>
                  ) : (
                    <span className="text-sm">{e.title}</span>
                  )}
                  <div className="text-[11px] text-zinc-400 mt-0.5">
                    {kstTime(e.published_at)}
                    {e.publisher ? ` · ${e.publisher}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ④ 최신 브리핑 한 개 — 첫 문단만. 나머지는 카드 안에서 펼친다. */}
        {analyses[0] && <BriefingCard a={analyses[0]} now={now} prominent previewLines={0} />}

        {/* ⑤ 규칙 — 한 줄. 미검증·성적·기저율·표본 수가 전부 이 줄 안에 있다. */}
        <SignalOneLine signalResult={signalResult} />

        <nav className="flex gap-4 text-xs text-zinc-500 pt-2">
          <Link href="/stock/horizons" className="hover:underline">
            예측 보드
          </Link>
          <Link href="/stock/data" className="hover:underline">
            데이터
          </Link>
          <Link href="/stock/decisions" className="hover:underline">
            결정 기록
          </Link>
        </nav>
      </main>
    </div>
  );
}
