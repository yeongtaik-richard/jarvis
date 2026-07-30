import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { getCollectorHealth } from '@/lib/collector-run-service';
import { StockAnalysisQuery, StockSnapshotQuery } from '@/lib/schemas';
import {
  searchStockAnalysis,
  toApiStockAnalysis,
  type ApiStockAnalysis,
} from '@/lib/stock-analysis-service';
import {
  getStockHistory,
  searchStockSnapshots,
  toApiStockSnapshot,
  type ApiStockSnapshot,
} from '@/lib/stock-service';
import { korQty, moneyMil, won } from './format';
import {
  CloseTrendChart,
  NetFlowChart,
  type ClosePoint,
  type FlowPoint,
} from './TrendCharts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function minutesAgo(iso: string, now: number): number {
  return Math.round((now - new Date(iso).getTime()) / 60000);
}
function freshnessBadge(mins: number): string {
  if (mins < 20) return 'bg-emerald-100 text-emerald-800';
  if (mins < 24 * 60) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}
function agoText(mins: number): string {
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

const METRIC_LABEL: Record<string, string> = {
  investor_flow: '수급 · 투자자별 순매수',
  daily_ohlcv: '일봉 (OHLCV)',
  foreign_holding: '외국인 보유',
  intraday_price: '장중 현재가',
};

type Tone = 'pos' | 'neg' | 'neutral';
type Row = { label: string; value: string; tone?: Tone; sub?: string };

function flowRow(
  label: string,
  net: number | null,
  buy: number | null,
  sell: number | null,
): Row {
  if (net === null) return { label, value: '—' };
  const sub =
    buy !== null && sell !== null
      ? `매수 ${moneyMil(buy)} · 매도 ${moneyMil(sell)}`
      : undefined;
  if (net === 0) return { label, value: '보합', tone: 'neutral', sub };
  const word = net > 0 ? '순매수' : '순매도';
  return {
    label,
    value: `${word} ${moneyMil(net)}`,
    tone: net > 0 ? 'pos' : 'neg',
    sub,
  };
}

function metricRows(item: ApiStockSnapshot): Row[] {
  const p = (item.payload ?? {}) as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = Number(p[k]);
    return Number.isFinite(v) ? v : null;
  };

  if (item.metric === 'investor_flow') {
    const close = num('close');
    return [
      { label: '종가', value: close === null ? '—' : won(close) },
      flowRow('외국인', num('foreign_net'), num('foreign_buy'), num('foreign_sell')),
      flowRow(
        '기관',
        num('institution_net'),
        num('institution_buy'),
        num('institution_sell'),
      ),
      flowRow('개인', num('individual_net'), num('individual_buy'), num('individual_sell')),
    ];
  }
  if (item.metric === 'daily_ohlcv') {
    const o = num('open');
    const c = num('close');
    const hi = num('high');
    const lo = num('low');
    const vol = num('volume');
    const chg = o && c ? ((c - o) / o) * 100 : null;
    const range = lo && hi ? ((hi - lo) / lo) * 100 : null;
    return [
      { label: '시가', value: o === null ? '—' : won(o) },
      { label: '고가', value: hi === null ? '—' : won(hi) },
      { label: '저가', value: lo === null ? '—' : won(lo) },
      {
        label: '종가',
        value: c === null ? '—' : won(c),
        tone: chg === null ? undefined : chg >= 0 ? 'pos' : 'neg',
      },
      {
        label: '등락(시가대비)',
        value: chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
        tone: chg === null ? undefined : chg >= 0 ? 'pos' : 'neg',
      },
      { label: '일중 변동폭', value: range === null ? '—' : `${range.toFixed(1)}%` },
      { label: '거래량', value: vol === null ? '—' : korQty(vol, '주') },
    ];
  }
  if (item.metric === 'intraday_price') {
    const price = num('price');
    const rate = num('change_rate');
    const vol = num('volume');
    // 이 지표의 거래대금만 단위가 원이다 (수급은 백만원) — payload.amount_unit 참고.
    const amount = num('amount_krw');
    return [
      {
        label: '현재가',
        value: price === null ? '—' : won(price),
        tone: rate === null ? undefined : rate >= 0 ? 'pos' : 'neg',
      },
      {
        label: '전일 대비',
        value: rate === null ? '—' : `${rate >= 0 ? '+' : ''}${rate}%`,
        tone: rate === null ? undefined : rate >= 0 ? 'pos' : 'neg',
      },
      { label: '고가', value: num('high') === null ? '—' : won(num('high')!) },
      { label: '저가', value: num('low') === null ? '—' : won(num('low')!) },
      { label: '누적 거래량', value: vol === null ? '—' : korQty(vol, '주') },
      { label: '누적 거래대금', value: amount === null ? '—' : korQty(amount, '원') },
    ];
  }
  if (item.metric === 'foreign_holding') {
    const ratio = num('foreign_ratio');
    const qty = num('foreign_qty');
    const price = num('price');
    return [
      { label: '보유비율', value: ratio === null ? '—' : `${ratio}%`, tone: 'neutral' },
      { label: '보유수량', value: qty === null ? '—' : korQty(qty, '주') },
      { label: '현재가', value: price === null ? '—' : won(price) },
    ];
  }
  // fallback: readable key/value of the raw payload
  return Object.entries(p).map(([k, v]) => ({
    label: k,
    value: typeof v === 'number' ? v.toLocaleString('ko-KR') : String(v),
  }));
}

// 부호 색은 국내 관례 — 빨강=순매수·상승, 파랑=순매도·하락. (emerald/rose는 색각 이상
// 판별에서 실패해서 갈아탔다. globals.css의 `.viz` 토큰과 같은 규칙.)
const toneClass: Record<Tone, string> = {
  pos: 'text-red-600 dark:text-red-400',
  neg: 'text-blue-600 dark:text-blue-400',
  neutral: 'text-zinc-700 dark:text-zinc-300',
};

const CLAIM_LABEL: Record<string, string> = {
  state_summary: '현황 요약',
  anomaly: '이상 신호',
  scenario: '시나리오',
  risk: '리스크',
  validated_directional: '검증된 방향성',
};
function claimBadge(ct: string): string {
  if (ct === 'anomaly') return 'bg-amber-100 text-amber-800';
  if (ct === 'risk') return 'bg-rose-100 text-rose-800';
  if (ct === 'scenario') return 'bg-blue-100 text-blue-800';
  return 'bg-zinc-200 text-zinc-700';
}
const KIND_LABEL: Record<string, string> = {
  pre: '프리마켓',
  intraday: '장중',
  close: '마감',
  ondemand: '온디맨드',
};

function BriefingCard({
  a,
  now,
  prominent = false,
}: {
  a: ApiStockAnalysis;
  now: number;
  prominent?: boolean;
}) {
  const mins = minutesAgo(a.created_at, now);
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
      <div className="text-sm whitespace-pre-wrap leading-relaxed">{a.body}</div>
      <div className="mt-2 text-[11px] text-zinc-400">
        {a.authored_by} · {a.symbol} · 예측 아님(참고용)
      </div>
    </div>
  );
}

const HISTORY_DAYS = 30;

const RUN_KIND_LABEL: Record<string, string> = {
  close: '마감',
  premarket: '프리마켓',
  backfill: '백필',
  manual: '수동',
};
const RUN_STATUS_BADGE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  running: 'bg-blue-100 text-blue-800',
  partial: 'bg-amber-100 text-amber-800',
  error: 'bg-rose-100 text-rose-800',
};

function kstTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function payloadNum(payload: unknown, key: string): number {
  const v = Number((payload as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) ? v : NaN;
}

export default async function StockDashboardPage() {
  const query = StockSnapshotQuery.parse({ latest: true, limit: 100 });
  const rows = await searchStockSnapshots(query);
  const items = rows.map(toApiStockSnapshot);
  const analyses = (
    await searchStockAnalysis(StockAnalysisQuery.parse({ limit: 5 }))
  ).map(toApiStockAnalysis);

  // 추이 차트용 이력 — 대시보드는 단일 종목이라 최신 스냅샷의 symbol을 따른다.
  const symbol = items[0]?.symbol ?? '000660';
  const [ohlcvRows, flowRows, health] = await Promise.all([
    getStockHistory(symbol, 'daily_ohlcv', HISTORY_DAYS),
    getStockHistory(symbol, 'investor_flow', HISTORY_DAYS),
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
  const lastCaptured = items.reduce<string | null>(
    (max, i) => (max && max >= i.captured_at ? max : i.captured_at),
    null,
  );

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Stock — 참고정보</h1>
          <p className="text-xs text-zinc-500 mt-1">
            reference state, not a signal · 예측 아님 ·{' '}
            <Link href="/stock/decisions" className="underline hover:text-zinc-700">
              매매 결정 로그
            </Link>
          </p>
        </div>

        <div className="text-sm text-zinc-500">
          {lastCaptured ? (
            <>
              마지막 수집{' '}
              <span
                className={`text-xs px-2 py-0.5 rounded ${freshnessBadge(minutesAgo(lastCaptured, now))}`}
              >
                {agoText(minutesAgo(lastCaptured, now))}
              </span>{' '}
              · {items.length}개 항목
              {health.last_run && (
                <>
                  {' '}
                  · 최근 실행 {RUN_KIND_LABEL[health.last_run.kind] ?? health.last_run.kind}{' '}
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${RUN_STATUS_BADGE[health.last_run.status] ?? 'bg-zinc-200 text-zinc-700'}`}
                  >
                    {health.last_run.status}
                  </span>
                </>
              )}
            </>
          ) : (
            '아직 수집된 데이터 없음'
          )}
        </div>

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
              {health.last_run?.error ? ` · ${health.last_run.error.slice(0, 160)}` : ''}
              . KRX 공휴일이면 정상입니다 — 스케줄은 휴장일을 모릅니다.
            </p>
          </div>
        )}

        {analyses.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              최신 브리핑
            </h2>
            <BriefingCard a={analyses[0]!} now={now} prominent />
            {analyses.length > 1 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-zinc-500 select-none">
                  이전 브리핑 {analyses.length - 1}건
                </summary>
                <div className="mt-2 space-y-2">
                  {analyses.slice(1).map((a) => (
                    <BriefingCard key={a.id} a={a} now={now} />
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        {items.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            수집된 스냅샷이 없습니다. 수집기(GitHub Actions)가 POST하면 여기 표시돼요.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((i) => {
              const mins = minutesAgo(i.captured_at, now);
              return (
                <section
                  key={i.id}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h2 className="font-medium">
                      {METRIC_LABEL[i.metric] ?? i.metric}
                    </h2>
                    <span
                      className={`shrink-0 text-xs px-2 py-0.5 rounded ${freshnessBadge(mins)}`}
                    >
                      {agoText(mins)}
                    </span>
                  </div>
                  <dl className="space-y-1.5 text-sm">
                    {metricRows(i).map((r) => (
                      <div key={r.label} className="flex justify-between gap-3">
                        <dt className="text-zinc-500 shrink-0">{r.label}</dt>
                        <dd className="text-right">
                          <span
                            className={`tabular-nums ${r.tone ? toneClass[r.tone] : ''}`}
                          >
                            {r.value}
                          </span>
                          {r.sub && (
                            <span className="block text-[11px] text-zinc-400 tabular-nums">
                              {r.sub}
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-900 text-[11px] text-zinc-400">
                    {i.symbol} · {i.source} · {i.trading_date_kst ?? i.bucket_key}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {(closePoints.length >= 2 || flowPoints.length >= 2) && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              추이
            </h2>
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
                          {periodChange.toFixed(2)}% · 기간
                        </div>
                      )}
                    </div>
                  </div>
                  <CloseTrendChart points={closePoints} />
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer select-none text-xs text-zinc-500">
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
                    <summary className="cursor-pointer select-none text-xs text-zinc-500">
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

        <p className="text-[11px] text-zinc-400 pt-2">
          수급은 KIS 투자자별 매매대금(백만원→조/억 환산). 순매수 = 매수 − 매도.
          일별 마감 후 수집. 부호 색은 국내 관례(빨강=순매수·상승, 파랑=순매도·하락).
        </p>
      </main>
    </div>
  );
}
