/**
 * `/stock/data` — 원천 지표·추이·국면.
 *
 * 세 페이지로 나눈 것 중 **가장 드물게 여는 쪽**이다. 장애가 났거나 "이 숫자 어디서
 * 나온 거지?"를 확인할 때만 온다. 그래서 밀도를 허용하고, 대신 `/stock`에서는 뺐다.
 *
 * 리듬이 다른 것을 한 스크롤에 섞은 게 원래 문제였다 — 하루에 수십 번 보는 가격과
 * 장애 때만 보는 원천 payload가 같은 페이지에 있었다.
 */

import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { getStockRegime } from '@/lib/stock-regime-service';
import { MarketEventQuery, StockSnapshotQuery } from '@/lib/schemas';
import {
  getStockHistory,
  searchStockSnapshots,
  toApiStockSnapshot,
  type ApiStockSnapshot,
} from '@/lib/stock-service';
import { getCollectorHealth } from '@/lib/collector-run-service';
import { korQty, moneyMil, won } from '../format';
import { CARD_METRICS, MetricCards } from '../cards';
import { RegimeCard } from '../RegimeCard';
import {
  isMarketHoursKst,
  kstTime,
  payloadNum,
  toneClass,
  RUN_KIND_LABEL,
  RUN_STATUS_BADGE,
  RUN_STATUS_WORD,
} from '../ui';
import {
  CloseTrendChart,
  NetFlowChart,
  type ClosePoint,
  type FlowPoint,
} from '../TrendCharts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HISTORY_DAYS = 30;

export default async function StockDataPage() {
  const rows = await searchStockSnapshots(StockSnapshotQuery.parse({ latest: true, limit: 100 }));
  const items = rows.map(toApiStockSnapshot);
  const symbol = items[0]?.symbol ?? '000660';

  const [ohlcvRows, flowRows, regimeResult, health] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', HISTORY_DAYS),
    getStockHistory(symbol, 'investor_flow', HISTORY_DAYS),
    getStockRegime(symbol),
    getCollectorHealth(symbol),
  ]);

  const closePoints: ClosePoint[] = ohlcvRows
    .map((r) => ({ date: r.bucketKey, close: payloadNum(r.payload, 'close') }))
    .filter((p) => Number.isFinite(p.close));
  const volumes = new Map(
    ohlcvRows.map((r) => [r.bucketKey, payloadNum(r.payload, 'volume')]),
  );
  const flowPoints: FlowPoint[] = flowRows
    .map((r) => ({
      date: r.bucketKey,
      foreign: payloadNum(r.payload, 'foreign_net'),
      institution: payloadNum(r.payload, 'institution_net'),
      individual: payloadNum(r.payload, 'individual_net'),
    }))
    .filter((p) => [p.foreign, p.institution, p.individual].every(Number.isFinite));

  const firstClose = closePoints[0]?.close;
  const lastClose = closePoints[closePoints.length - 1]?.close;
  const periodChange =
    firstClose && lastClose ? ((lastClose - firstClose) / firstClose) * 100 : null;

  const now = Date.now();
  const marketOpen = isMarketHoursKst(now);
  const cards = CARD_METRICS.map((m) => items.find((i) => i.metric === m)).filter(
    (i): i is ApiStockSnapshot => Boolean(i),
  );

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">데이터</h1>
          <span className="text-xs text-zinc-500">수집된 값·추이·국면</span>
          <Link href="/stock" className="ml-auto text-sm text-zinc-500 hover:underline">
            ← 오늘
          </Link>
        </div>

        {/* 수집 실행 이력 — 이 페이지의 첫 질문이 대개 "수집이 돌긴 했나"다. */}
        <div className="text-sm text-zinc-500">
          {health.last_run ? (
            <>
              최근 실행 {RUN_KIND_LABEL[health.last_run.kind] ?? health.last_run.kind}{' '}
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${RUN_STATUS_BADGE[health.last_run.status] ?? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}
              >
                {RUN_STATUS_WORD[health.last_run.status] ?? health.last_run.status}
              </span>{' '}
              <span className="text-xs text-zinc-400">
                {kstTime(health.last_run.finished_at ?? health.last_run.started_at)}
              </span>
              {health.last_run.error && (
                <span className="text-xs text-zinc-400">
                  {' '}
                  · {health.last_run.error.slice(0, 120)}
                </span>
              )}
            </>
          ) : (
            '아직 수집 실행 기록이 없다'
          )}
        </div>

        <MetricCards cards={cards} now={now} marketOpen={marketOpen} />

        {(closePoints.length >= 2 || flowPoints.length >= 2) && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">추이</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {closePoints.length >= 2 && (
                <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
                  <div className="flex items-baseline justify-between gap-2 mb-2">
                    <h3 className="font-medium">
                      종가{' '}
                      <span className="text-xs font-normal text-zinc-400">
                        최근 {closePoints.length}거래일
                      </span>
                    </h3>
                    <div className="text-right">
                      <div className="font-medium">{won(lastClose!)}</div>
                      {periodChange !== null && (
                        <div
                          className={`text-xs tabular-nums ${periodChange >= 0 ? toneClass.pos : toneClass.neg}`}
                        >
                          {periodChange >= 0 ? '+' : ''}
                          {periodChange.toFixed(2)}% / {closePoints.length}거래일
                        </div>
                      )}
                    </div>
                  </div>
                  <CloseTrendChart points={closePoints} />
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
                      표로 보기
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs tabular-nums">
                        <thead className="text-zinc-500">
                          <tr>
                            <th className="text-left font-normal py-1">날짜</th>
                            <th className="text-right font-normal py-1">종가</th>
                            <th className="text-right font-normal py-1">거래량</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...closePoints].reverse().map((p) => (
                            <tr
                              key={p.date}
                              className="border-t border-zinc-100 dark:border-zinc-900"
                            >
                              <td className="py-1">{p.date}</td>
                              <td className="py-1 text-right">{won(p.close)}</td>
                              <td className="py-1 text-right">
                                {Number.isFinite(volumes.get(p.date))
                                  ? korQty(volumes.get(p.date)!, '주')
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              )}

              {flowPoints.length >= 2 && (
                <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
                  <h3 className="font-medium mb-2">
                    투자자별 순매수{' '}
                    <span className="text-xs font-normal text-zinc-400">
                      최근 {flowPoints.length}거래일
                    </span>
                  </h3>
                  <NetFlowChart points={flowPoints} />
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer select-none text-xs text-zinc-500 py-2">
                      표로 보기
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs tabular-nums">
                        <thead className="text-zinc-500">
                          <tr>
                            <th className="text-left font-normal py-1">날짜</th>
                            <th className="text-right font-normal py-1">외국인</th>
                            <th className="text-right font-normal py-1">기관</th>
                            <th className="text-right font-normal py-1">개인</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...flowPoints].reverse().map((p) => (
                            <tr
                              key={p.date}
                              className="border-t border-zinc-100 dark:border-zinc-900"
                            >
                              <td className="py-1">{p.date}</td>
                              {[p.foreign, p.institution, p.individual].map((v, idx) => (
                                <td
                                  key={idx}
                                  className={`py-1 text-right ${v === 0 ? '' : v > 0 ? toneClass.pos : toneClass.neg}`}
                                >
                                  {v === 0 ? '보합' : `${v > 0 ? '+' : '−'}${moneyMil(v)}`}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              )}
            </div>
          </section>
        )}

        <RegimeCard regimeResult={regimeResult} />
      </main>
    </div>
  );
}
