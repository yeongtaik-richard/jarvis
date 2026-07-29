import { Header } from '@/app/components/Header';
import { StockSnapshotQuery } from '@/lib/schemas';
import { searchStockSnapshots, toApiStockSnapshot } from '@/lib/stock-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function minutesAgo(iso: string, now: number): number {
  return Math.round((now - new Date(iso).getTime()) / 60000);
}

function freshnessBadge(mins: number): string {
  if (mins < 20) return 'bg-emerald-100 text-emerald-800';
  if (mins < 120) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}

function agoText(mins: number): string {
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

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
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">Stock — 참고정보</h1>
          <span className="text-xs text-zinc-500">
            reference state, not a signal · 예측 아님
          </span>
        </div>

        <div className="text-sm text-zinc-500">
          {lastCaptured
            ? `마지막 수집: ${agoText(minutesAgo(lastCaptured, now))} (${lastCaptured})`
            : '아직 수집된 데이터 없음'}
          {' · '}
          {items.length}개 항목
        </div>

        {items.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            수집된 스냅샷이 없습니다. 수집기(GitHub Actions)가 POST하면 여기 표시돼요.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <th className="py-2 pr-4 font-medium">지표(metric)</th>
                  <th className="py-2 pr-4 font-medium">종목</th>
                  <th className="py-2 pr-4 font-medium">소스</th>
                  <th className="py-2 pr-4 font-medium">기준일/버킷</th>
                  <th className="py-2 pr-4 font-medium">신선도</th>
                  <th className="py-2 font-medium">payload</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const mins = minutesAgo(i.captured_at, now);
                  return (
                    <tr
                      key={i.id}
                      className="border-b border-zinc-100 dark:border-zinc-900 align-top"
                    >
                      <td className="py-2 pr-4 font-medium">{i.metric}</td>
                      <td className="py-2 pr-4">{i.symbol}</td>
                      <td className="py-2 pr-4 text-zinc-500">{i.source}</td>
                      <td className="py-2 pr-4 text-zinc-500">
                        {i.trading_date_kst ?? i.bucket_key}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${freshnessBadge(mins)}`}
                        >
                          {agoText(mins)}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-zinc-500 font-mono max-w-md truncate">
                        {JSON.stringify(i.payload)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
