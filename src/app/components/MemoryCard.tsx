import Link from 'next/link';
import type { ApiMemory } from '@/lib/memory-service';

const KIND_BADGE: Record<ApiMemory['kind'], string> = {
  event: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  fact: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  relationship: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  trigger: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
};

const STATUS_BADGE: Record<ApiMemory['status'], string> = {
  planned: 'border-blue-400 text-blue-700 dark:text-blue-300',
  actual: 'border-emerald-400 text-emerald-700 dark:text-emerald-300',
  cancelled: 'border-zinc-400 text-zinc-500 line-through',
  active: 'border-amber-400 text-amber-700 dark:text-amber-300',
  resolved: 'border-zinc-300 text-zinc-500',
  na: 'border-transparent text-transparent',
};

function fmt(d: string | null): string {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

export function MemoryCard({ m }: { m: ApiMemory }) {
  const time = m.actual_time ?? m.start_time;
  return (
    <Link
      href={`/m/${m.id}`}
      className="block p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
    >
      <div className="flex flex-wrap items-baseline gap-2 mb-1">
        <span className={`text-xs px-2 py-0.5 rounded ${KIND_BADGE[m.kind]}`}>{m.kind}</span>
        {m.status !== 'na' && (
          <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_BADGE[m.status]}`}>
            {m.status}
          </span>
        )}
        {m.importance > 0 && (
          <span className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300">
            {m.importance === 2 ? '📌 pin' : '★ important'}
          </span>
        )}
        {m.op === 'delete' && (
          <span className="text-xs px-2 py-0.5 rounded bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            deleted
          </span>
        )}
        <span className="text-xs text-zinc-500 ml-auto">{fmt(time)}</span>
      </div>
      <div className={`font-medium ${m.op === 'delete' ? 'line-through text-zinc-500' : ''}`}>
        {m.title}
      </div>
      {m.body && <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2">{m.body}</div>}
      {m.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {m.tags.map((t) => (
            <span
              key={t}
              className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
