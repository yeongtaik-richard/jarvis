import { Header } from '@/app/components/Header';
import { StockSnapshotQuery } from '@/lib/schemas';
import {
  searchStockSnapshots,
  toApiStockSnapshot,
  type ApiStockSnapshot,
} from '@/lib/stock-service';

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

const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;
function korQty(n: number, suffix = ''): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(2)}억${suffix}`;
  if (a >= 1e4) return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만${suffix}`;
  return `${n.toLocaleString('ko-KR')}${suffix}`;
}

const METRIC_LABEL: Record<string, string> = {
  investor_flow: '수급 · 투자자별 순매수',
  daily_ohlcv: '일봉 (OHLCV)',
  foreign_holding: '외국인 보유',
};

type Tone = 'pos' | 'neg' | 'neutral';
type Row = { label: string; value: string; tone?: Tone };

function flowRow(label: string, v: number | null): Row {
  if (v === null) return { label, value: '—' };
  if (v === 0) return { label, value: '보합', tone: 'neutral' };
  const word = v > 0 ? '순매수' : '순매도';
  return {
    label,
    value: `${word} ${Math.abs(v).toLocaleString('ko-KR')}`,
    tone: v > 0 ? 'pos' : 'neg',
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
      flowRow('외국인', num('foreign_net')),
      flowRow('기관', num('institution_net')),
      flowRow('개인', num('individual_net')),
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

const toneClass: Record<Tone, string> = {
  pos: 'text-emerald-600 dark:text-emerald-400',
  neg: 'text-rose-600 dark:text-rose-400',
  neutral: 'text-zinc-700 dark:text-zinc-300',
};

export default async function StockDashboardPage() {
  const query = StockSnapshotQuery.parse({ latest: true, limit: 100 });
  const rows = await searchStockSnapshots(query);
  const items = rows.map(toApiStockSnapshot);
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
            reference state, not a signal · 예측 아님
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
            </>
          ) : (
            '아직 수집된 데이터 없음'
          )}
        </div>

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
                        <dt className="text-zinc-500">{r.label}</dt>
                        <dd
                          className={`text-right tabular-nums ${r.tone ? toneClass[r.tone] : ''}`}
                        >
                          {r.value}
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

        <p className="text-[11px] text-zinc-400 pt-2">
          수급 순매수는 KIS 순매수 금액(부호=방향). 일별 마감 후 수집.
        </p>
      </main>
    </div>
  );
}
