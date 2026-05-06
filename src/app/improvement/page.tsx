import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { searchImprovements, toApiImprovement } from '@/lib/improvement-service';
import { ImprovementSearchQuery } from '@/lib/schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800',
  triaged: 'bg-blue-100 text-blue-800',
  applied: 'bg-emerald-100 text-emerald-800',
  wontfix: 'bg-zinc-200 text-zinc-700',
};

export default async function ImprovementListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const parsed = ImprovementSearchQuery.safeParse({ ...sp, limit: 100 });
  const query = parsed.success ? parsed.data : ImprovementSearchQuery.parse({ limit: 100 });
  const rows = await searchImprovements(query);
  const items = rows.map(toApiImprovement);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <h1 className="text-xl font-semibold">Improvement Notes</h1>
        <form className="flex gap-2 items-end">
          <label className="flex flex-col text-xs">
            <span className="text-zinc-500 mb-1">Status</span>
            <select
              name="status"
              defaultValue={sp.status ?? ''}
              className="px-2 py-1 border rounded bg-transparent text-sm"
            >
              <option value="">— any —</option>
              <option value="open">open</option>
              <option value="triaged">triaged</option>
              <option value="applied">applied</option>
              <option value="wontfix">wontfix</option>
            </select>
          </label>
          <button
            type="submit"
            className="px-3 py-1.5 rounded bg-zinc-900 text-white dark:bg-white dark:text-black text-sm"
          >
            Apply
          </button>
        </form>

        <div className="text-sm text-zinc-500">{items.length}건</div>

        {items.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">없음.</div>
        ) : (
          <div className="space-y-3">
            {items.map((n) => (
              <Link
                key={n.id}
                href={`/improvement/${n.id}`}
                className="block p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400"
              >
                <div className="flex items-baseline gap-2 mb-1">
                  <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[n.status]}`}>
                    {n.status}
                  </span>
                  {n.priority > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                      P{n.priority}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500 ml-auto">{n.created_at}</span>
                </div>
                <div className="font-medium">{n.observed_request}</div>
                <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 line-clamp-2">
                  {n.missing_capability}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
