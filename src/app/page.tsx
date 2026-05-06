import Link from 'next/link';
import { Header } from '@/app/components/Header';
import { MemoryCard } from '@/app/components/MemoryCard';
import { search, toApiMemory } from '@/lib/memory-service';
import { SearchQuery } from '@/lib/schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Search = {
  q?: string;
  kind?: string;
  status?: string;
  tag?: string;
  on_month_day?: string;
  include_history?: string;
  include_deleted?: string;
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const parsed = SearchQuery.safeParse({ ...sp, limit: 50 });
  const query = parsed.success ? parsed.data : SearchQuery.parse({ limit: 50 });
  const rows = await search(query);
  const items = rows.map(toApiMemory);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <FilterBar values={sp} />
        <div className="text-sm text-zinc-500">{items.length}건</div>
        {items.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            메모리 없음. <Link href="/new" className="underline">새로 추가</Link>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((m) => (
              <MemoryCard key={m.id} m={m} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function FilterBar({ values }: { values: Search }) {
  return (
    <form className="flex flex-wrap gap-2 items-end">
      <Field label="Search" name="q" defaultValue={values.q} placeholder="키워드" />
      <SelectField
        label="Kind"
        name="kind"
        defaultValue={values.kind}
        options={['', 'event', 'fact', 'relationship', 'trigger']}
      />
      <SelectField
        label="Status"
        name="status"
        defaultValue={values.status}
        options={['', 'planned', 'actual', 'cancelled', 'active', 'resolved', 'na']}
      />
      <Field label="Tag" name="tag" defaultValue={values.tag} placeholder="trip:목포" />
      <Field
        label="On (MM-DD)"
        name="on_month_day"
        defaultValue={values.on_month_day}
        placeholder="09-28"
      />
      <CheckboxField
        label="History"
        name="include_history"
        defaultChecked={values.include_history === 'true'}
      />
      <CheckboxField
        label="Deleted"
        name="include_deleted"
        defaultChecked={values.include_deleted === 'true'}
      />
      <button
        type="submit"
        className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-white dark:text-black text-sm"
      >
        Apply
      </button>
      <Link
        href="/"
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

function CheckboxField({
  label,
  name,
  defaultChecked,
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-zinc-500 px-2 py-1">
      <input
        type="checkbox"
        name={name}
        value="true"
        defaultChecked={defaultChecked}
        className="accent-zinc-700"
      />
      {label}
    </label>
  );
}
