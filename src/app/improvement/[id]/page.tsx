import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header } from '@/app/components/Header';
import { getImprovementById, toApiImprovement } from '@/lib/improvement-service';
import { updateImprovementAction } from '../actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function ImprovementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const row = await getImprovementById(id);
  if (!row) notFound();
  const n = toApiImprovement(row);

  async function updateBound(formData: FormData) {
    'use server';
    return updateImprovementAction(id, formData);
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <Link href="/improvement" className="text-sm text-zinc-500 hover:text-zinc-800">
            ← Improvements
          </Link>
        </div>
        <div className="p-4 rounded border border-zinc-300 dark:border-zinc-700 space-y-2">
          <div className="text-xs text-zinc-500">id: {n.id}</div>
          <div>
            <div className="text-xs text-zinc-500">Observed request</div>
            <div className="whitespace-pre-wrap">{n.observed_request}</div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Missing capability</div>
            <div className="whitespace-pre-wrap">{n.missing_capability}</div>
          </div>
          {n.proposed_fix && (
            <div>
              <div className="text-xs text-zinc-500">Proposed fix</div>
              <div className="whitespace-pre-wrap">{n.proposed_fix}</div>
            </div>
          )}
          {n.example_memory_id && (
            <div className="text-xs">
              example_memory:{' '}
              <Link href={`/m/${n.example_memory_id}`} className="underline">
                {n.example_memory_id}
              </Link>
            </div>
          )}
          <div className="text-xs text-zinc-500">
            created {n.created_at} {n.resolved_at && `· resolved ${n.resolved_at}`}
          </div>
          {n.resolution_note && (
            <div>
              <div className="text-xs text-zinc-500">Resolution note</div>
              <div className="whitespace-pre-wrap">{n.resolution_note}</div>
            </div>
          )}
        </div>

        <form action={updateBound} className="space-y-3 p-4 rounded border border-zinc-200 dark:border-zinc-800">
          <h2 className="font-semibold">상태 갱신</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1">Status</span>
              <select
                name="status"
                defaultValue={n.status}
                className="w-full px-3 py-2 border rounded bg-transparent text-sm"
              >
                <option value="open">open</option>
                <option value="triaged">triaged</option>
                <option value="applied">applied</option>
                <option value="wontfix">wontfix</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1">Priority (0–3)</span>
              <input
                name="priority"
                type="number"
                min={0}
                max={3}
                defaultValue={n.priority}
                className="w-full px-3 py-2 border rounded bg-transparent text-sm"
              />
            </label>
          </div>
          <div>
            <span className="block text-xs text-zinc-500 mb-1">Proposed fix</span>
            <textarea
              name="proposed_fix"
              rows={2}
              defaultValue={n.proposed_fix ?? ''}
              className="w-full px-3 py-2 border rounded bg-transparent text-sm"
            />
          </div>
          <div>
            <span className="block text-xs text-zinc-500 mb-1">Resolution note</span>
            <textarea
              name="resolution_note"
              rows={2}
              defaultValue={n.resolution_note ?? ''}
              className="w-full px-3 py-2 border rounded bg-transparent text-sm"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-white dark:text-black"
            >
              Update
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
