import type { ApiMemory } from '@/lib/memory-service';

type Props = {
  action: (formData: FormData) => Promise<void> | void;
  initial?: Partial<ApiMemory>;
  submitLabel?: string;
};

const KINDS = ['event', 'fact', 'relationship', 'trigger'] as const;
const STATUSES = ['planned', 'actual', 'cancelled', 'active', 'resolved', 'na'] as const;
const PRECISIONS = ['exact', 'date', 'month', 'unknown'] as const;

// timestamptz를 datetime-local input에 넣을 형태(YYYY-MM-DDTHH:mm)로 변환.
// 단순화를 위해 Asia/Seoul 기준으로 표시. 입력 시 사용자에게 timezone 칸 별도 제공.
function toLocalInput(iso: string | null | undefined, tz = 'Asia/Seoul'): string {
  if (!iso) return '';
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function MemoryForm({ action, initial = {}, submitLabel = 'Save' }: Props) {
  const tz = initial.timezone ?? 'Asia/Seoul';
  return (
    <form action={action} className="space-y-4">
      <div>
        <label className="block text-xs text-zinc-500 mb-1">Title *</label>
        <input
          name="title"
          required
          defaultValue={initial.title ?? ''}
          className="w-full px-3 py-2 border rounded bg-transparent"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500 mb-1">Body</label>
        <textarea
          name="body"
          rows={3}
          defaultValue={initial.body ?? ''}
          className="w-full px-3 py-2 border rounded bg-transparent"
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Select name="kind" label="Kind" options={KINDS} defaultValue={initial.kind ?? 'event'} />
        <Select
          name="status"
          label="Status"
          options={STATUSES}
          defaultValue={initial.status ?? 'na'}
        />
        <Select
          name="time_precision"
          label="Time precision"
          options={PRECISIONS}
          defaultValue={initial.time_precision ?? 'exact'}
        />
        <Select
          name="importance"
          label="Importance"
          options={['0', '1', '2']}
          defaultValue={String(initial.importance ?? 0)}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <DateField name="start_time" label="Start" defaultValue={toLocalInput(initial.start_time, tz)} />
        <DateField name="end_time" label="End" defaultValue={toLocalInput(initial.end_time, tz)} />
        <DateField
          name="actual_time"
          label="Actual"
          defaultValue={toLocalInput(initial.actual_time, tz)}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Timezone</label>
          <input
            name="timezone"
            defaultValue={tz}
            className="w-full px-3 py-2 border rounded bg-transparent text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Raw time text</label>
          <input
            name="raw_time_text"
            defaultValue={initial.raw_time_text ?? ''}
            placeholder="다음 주 화요일 점심"
            className="w-full px-3 py-2 border rounded bg-transparent text-sm"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-zinc-500 mb-1">Tags (comma-separated)</label>
        <input
          name="tags"
          defaultValue={(initial.tags ?? []).join(', ')}
          placeholder="trip:목포, family:wife"
          className="w-full px-3 py-2 border rounded bg-transparent text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500 mb-1">
          Attributes (JSON)
        </label>
        <textarea
          name="attributes"
          rows={3}
          defaultValue={JSON.stringify(initial.attributes ?? {}, null, 2)}
          className="w-full px-3 py-2 border rounded bg-transparent text-sm font-mono"
        />
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          className="px-4 py-2 rounded bg-zinc-900 text-white dark:bg-white dark:text-black"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Select({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: readonly string[];
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-500 mb-1">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 border rounded bg-transparent text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateField({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-500 mb-1">{label}</span>
      <input
        type="datetime-local"
        name={name}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 border rounded bg-transparent text-sm"
      />
    </label>
  );
}
