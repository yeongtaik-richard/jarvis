'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { patchImprovement } from '@/lib/improvement-service';
import { PatchImprovementInput } from '@/lib/schemas';

export async function updateImprovementAction(id: string, formData: FormData) {
  const status = formData.get('status')?.toString();
  const proposedFix = formData.get('proposed_fix')?.toString() ?? null;
  const resolutionNote = formData.get('resolution_note')?.toString() ?? null;
  const priorityRaw = formData.get('priority')?.toString();

  const parsed = PatchImprovementInput.parse({
    status: status || undefined,
    proposed_fix: proposedFix || null,
    resolution_note: resolutionNote || null,
    priority: priorityRaw ? Number(priorityRaw) : undefined,
  });

  await patchImprovement(id, parsed);
  revalidatePath('/improvement');
  revalidatePath(`/improvement/${id}`);
  redirect(`/improvement/${id}`);
}
