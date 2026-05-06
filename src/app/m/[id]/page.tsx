import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header } from '@/app/components/Header';
import { MemoryForm } from '@/app/components/MemoryForm';
import { MemoryCard } from '@/app/components/MemoryCard';
import {
  getById,
  getThreadHistory,
  toApiMemory,
  type ApiMemory,
} from '@/lib/memory-service';
import { deleteMemoryAction, patchMemoryAction } from './actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function MemoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const row = await getById(id);
  if (!row) notFound();
  const current = toApiMemory(row);
  const history = (await getThreadHistory(row.threadId)).map(toApiMemory);
  const olderVersions = history.filter((h) => h.id !== current.id);

  // Server actions are top-level functions; bind id via wrappers.
  async function patchBound(formData: FormData) {
    'use server';
    return patchMemoryAction(id, formData);
  }
  async function deleteBound() {
    'use server';
    return deleteMemoryAction(id);
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-8">
        <div>
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
            ← 목록으로
          </Link>
        </div>

        <section>
          <CurrentSummary m={current} />
        </section>

        {!current.deleted_at && current.op !== 'delete' && (
          <section>
            <h2 className="text-lg font-semibold mb-3">수정 (새 version으로 supersede)</h2>
            <MemoryForm action={patchBound} initial={current} submitLabel="Save new version" />
            <form action={deleteBound} className="mt-4">
              <button
                type="submit"
                className="px-3 py-1.5 text-sm rounded border border-red-400 text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30"
              >
                Delete (tombstone)
              </button>
            </form>
          </section>
        )}

        {olderVersions.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-3">Thread history</h2>
            <div className="space-y-3">
              {olderVersions.map((m) => (
                <MemoryCard key={m.id} m={m} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function CurrentSummary({ m }: { m: ApiMemory }) {
  return (
    <div className="p-4 rounded border border-zinc-300 dark:border-zinc-700 space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800">
          {m.kind} / {m.status} / {m.op}
        </span>
        {m.importance > 0 && (
          <span className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800">
            importance {m.importance}
          </span>
        )}
        <span className="text-xs text-zinc-500 ml-auto">id: {m.id}</span>
      </div>
      <div className="font-medium text-lg">{m.title}</div>
      {m.body && <div className="text-sm whitespace-pre-wrap">{m.body}</div>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <Row label="thread_id" value={m.thread_id} />
        <Row label="supersedes_id" value={m.supersedes_id ?? '—'} />
        <Row label="start_time" value={m.start_time ?? '—'} />
        <Row label="end_time" value={m.end_time ?? '—'} />
        <Row label="actual_time" value={m.actual_time ?? '—'} />
        <Row label="timezone" value={m.timezone ?? '—'} />
        <Row label="time_precision" value={m.time_precision} />
        <Row label="raw_time_text" value={m.raw_time_text ?? '—'} />
        <Row label="created_at" value={m.created_at} />
        <Row label="deleted_at" value={m.deleted_at ?? '—'} />
      </dl>
      {m.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {m.tags.map((t) => (
            <span
              key={t}
              className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {Object.keys(m.attributes).length > 0 && (
        <pre className="text-xs bg-zinc-50 dark:bg-zinc-900 rounded p-2 overflow-x-auto">
          {JSON.stringify(m.attributes, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-mono">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </>
  );
}
