'use server';

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createOrSupersede, softDelete } from '@/lib/memory-service';
import { syncThreadToCalendar } from '@/lib/calendar-sync';
import { CreateMemoryInput } from '@/lib/schemas';
import { localInputToIso, parseAttributes, parseTags } from '@/lib/form-parsing';

export async function patchMemoryAction(id: string, formData: FormData) {
  const tz = String(formData.get('timezone') || 'Asia/Seoul');
  const raw = {
    title: String(formData.get('title') || ''),
    body: stringOrNull(formData.get('body')),
    kind: String(formData.get('kind') || 'event'),
    status: String(formData.get('status') || 'na'),
    start_time: localInputToIso(String(formData.get('start_time') || ''), tz),
    end_time: localInputToIso(String(formData.get('end_time') || ''), tz),
    actual_time: localInputToIso(String(formData.get('actual_time') || ''), tz),
    timezone: tz,
    time_precision: String(formData.get('time_precision') || 'exact'),
    raw_time_text: stringOrNull(formData.get('raw_time_text')),
    importance: Number(formData.get('importance') || 0),
    tags: parseTags(formData.get('tags')?.toString()),
    attributes: parseAttributes(formData.get('attributes')?.toString()),
    source: 'web' as const,
    supersedes_id: id,
  };
  const parsed = CreateMemoryInput.parse(raw);
  const created = await createOrSupersede(parsed);
  after(() => syncThreadToCalendar(created.threadId));
  revalidatePath('/');
  revalidatePath(`/m/${id}`);
  redirect(`/m/${created.id}`);
}

export async function deleteMemoryAction(id: string) {
  const tombstone = await softDelete(id);
  after(() => syncThreadToCalendar(tombstone.threadId));
  revalidatePath('/');
  redirect('/');
}

function stringOrNull(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v);
  return s.trim() === '' ? null : s;
}
