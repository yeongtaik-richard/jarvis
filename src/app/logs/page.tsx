import Link from 'next/link';
import { and, desc, eq, gte, lte, like, sql } from 'drizzle-orm';
import { Header } from '@/app/components/Header';
import { db } from '@/db/client';
import { requestLogs, type RequestLog } from '@/db/schema';
import { PruneButton } from './PruneButton';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Search = {
  status?: string;
  status_class?: string; // '2xx' | '4xx' | '5xx'
  path?: string;
  since_hours?: string;
  limit?: string;
  page?: string;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_SINCE_HOURS = 24;

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  const sinceHours = clampInt(sp.since_hours, DEFAULT_SINCE_HOURS, 1, 24 * 30);
  const limit = clampInt(sp.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const page = clampInt(sp.page, 1, 1, 1_000_000);
  const offset = (page - 1) * limit;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

  const conditions = [gte(requestLogs.ts, since)];
  const statusNum = Number(sp.status);
  if (Number.isFinite(statusNum) && statusNum >= 100 && statusNum < 600) {
    conditions.push(eq(requestLogs.status, statusNum));
  }
  if (sp.status_class === '2xx') {
    conditions.push(gte(requestLogs.status, 200), lte(requestLogs.status, 299));
  } else if (sp.status_class === '3xx') {
    conditions.push(gte(requestLogs.status, 300), lte(requestLogs.status, 399));
  } else if (sp.status_class === '4xx') {
    conditions.push(gte(requestLogs.status, 400), lte(requestLogs.status, 499));
  } else if (sp.status_class === '5xx') {
    conditions.push(gte(requestLogs.status, 500), lte(requestLogs.status, 599));
  }
  if (sp.path) {
    conditions.push(like(requestLogs.path, `%${sp.path}%`));
  }

  const where = and(...conditions);

  const rows = await db
    .select()
    .from(requestLogs)
    .where(where)
    .orderBy(desc(requestLogs.ts))
    .limit(limit)
    .offset(offset);

  const filteredCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(requestLogs)
    .where(where)
    .then((r) => r[0].n);

  const totalPages = Math.max(1, Math.ceil(filteredCount / limit));

  const summary = await db
    .select({
      total: sql<number>`count(*)::int`,
      err4xx: sql<number>`count(*) filter (where status >= 400 and status < 500)::int`,
      err5xx: sql<number>`count(*) filter (where status >= 500)::int`,
      avgMs: sql<number>`coalesce(avg(duration_ms), 0)::int`,
      p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::int`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.ts, since));

  const s = summary[0];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <FilterBar values={sp} />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
          <Stat label={`최근 ${sinceHours}h 요청`} value={s.total.toString()} />
          <Stat label="4xx" value={s.err4xx.toString()} tone={s.err4xx > 0 ? 'warn' : undefined} />
          <Stat label="5xx" value={s.err5xx.toString()} tone={s.err5xx > 0 ? 'err' : undefined} />
          <Stat label="평균 (ms)" value={s.avgMs.toString()} />
          <Stat label="p95 (ms)" value={s.p95Ms.toString()} />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-sm text-zinc-500">
            전체 {filteredCount}건 / {page}페이지 ({offset + 1}–{Math.min(
              offset + rows.length,
              filteredCount,
            )})
          </div>
          <PruneButton />
        </div>
        <LogTable rows={rows} />
        <Pagination page={page} totalPages={totalPages} searchParams={sp} />
      </main>
    </div>
  );
}

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function LogTable({ rows }: { rows: RequestLog[] }) {
  if (rows.length === 0) {
    return <div className="text-center py-12 text-zinc-500">로그 없음</div>;
  }
  return (
    <div className="overflow-x-auto border border-zinc-200 dark:border-zinc-800 rounded">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500 text-xs uppercase">
          <tr>
            <Th>Time</Th>
            <Th>Method</Th>
            <Th>Path</Th>
            <Th>Status</Th>
            <Th>ms</Th>
            <Th>IP</Th>
            <Th>UA / Error</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-zinc-200 dark:border-zinc-800 align-top"
            >
              <Td className="whitespace-nowrap font-mono text-xs">{formatTs(r.ts)}</Td>
              <Td className="font-mono">{r.method}</Td>
              <Td className="font-mono break-all">{r.path}</Td>
              <Td>
                <StatusBadge code={r.status} />
              </Td>
              <Td className="font-mono">{r.durationMs}</Td>
              <Td className="font-mono text-xs text-zinc-500">{r.ip ?? '—'}</Td>
              <Td className="text-xs text-zinc-500 max-w-md">
                {r.error ? (
                  <span className="text-red-600 dark:text-red-400 break-all">{r.error}</span>
                ) : (
                  <span className="break-all">{r.userAgent ?? '—'}</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTs(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

function StatusBadge({ code }: { code: number }) {
  const tone =
    code >= 500
      ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
      : code >= 400
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : code >= 300
          ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono ${tone}`}>{code}</span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'err' }) {
  const color =
    tone === 'err'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-zinc-900 dark:text-zinc-100';
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-3 py-2 font-medium">{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: Search;
}) {
  if (totalPages <= 1) return null;

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== 'page') params.set(k, v);
    }
    params.set('page', String(p));
    return `/logs?${params.toString()}`;
  }

  const prev = page > 1 ? hrefFor(page - 1) : null;
  const next = page < totalPages ? hrefFor(page + 1) : null;

  const baseLink =
    'px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 text-sm';
  const disabled = 'opacity-40 pointer-events-none';

  return (
    <div className="flex items-center justify-center gap-2 text-sm">
      {prev ? (
        <Link href={prev} className={baseLink}>
          이전
        </Link>
      ) : (
        <span className={`${baseLink} ${disabled}`}>이전</span>
      )}
      <span className="text-zinc-500">
        {page} / {totalPages}
      </span>
      {next ? (
        <Link href={next} className={baseLink}>
          다음
        </Link>
      ) : (
        <span className={`${baseLink} ${disabled}`}>다음</span>
      )}
    </div>
  );
}

function FilterBar({ values }: { values: Search }) {
  return (
    <form className="flex flex-wrap gap-2 items-end">
      <Field
        label="Since (hours)"
        name="since_hours"
        defaultValue={values.since_hours ?? String(DEFAULT_SINCE_HOURS)}
        placeholder="24"
      />
      <SelectField
        label="Status class"
        name="status_class"
        defaultValue={values.status_class}
        options={['', '2xx', '3xx', '4xx', '5xx']}
      />
      <Field label="Status (exact)" name="status" defaultValue={values.status} placeholder="500" />
      <Field label="Path contains" name="path" defaultValue={values.path} placeholder="/api/memory" />
      <Field
        label="Limit"
        name="limit"
        defaultValue={values.limit ?? String(DEFAULT_LIMIT)}
        placeholder="200"
      />
      <button
        type="submit"
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-white dark:text-black text-sm"
      >
        Apply
      </button>
      <Link
        href="/logs"
        className="px-4 py-2 rounded border border-zinc-300 dark:border-zinc-700 text-sm"
      >
        Reset
      </Link>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col text-xs">
      <span className="text-zinc-500 mb-1">{label}</span>
      <input
        name={name}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        className="px-2 py-1 border rounded bg-transparent text-sm w-40"
      />
    </label>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  options: string[];
}) {
  return (
    <label className="flex flex-col text-xs">
      <span className="text-zinc-500 mb-1">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue ?? ''}
        className="px-2 py-1 border rounded bg-transparent text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || '— any —'}
          </option>
        ))}
      </select>
    </label>
  );
}
