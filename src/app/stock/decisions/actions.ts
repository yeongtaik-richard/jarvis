'use server';

import { revalidatePath } from 'next/cache';
import { CreateTradeDecisionInput, PatchTradeDecisionInput } from '@/lib/schemas';
import { createTradeDecision, patchTradeDecision } from '@/lib/trade-decision-service';

function numField(form: FormData, key: string): number | null {
  const raw = form.get(key)?.toString().trim().replace(/,/g, '');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export async function createDecisionAction(formData: FormData) {
  const parsed = CreateTradeDecisionInput.parse({
    symbol: formData.get('symbol')?.toString() || '000660',
    action: formData.get('action')?.toString(),
    price: numField(formData, 'price'),
    quantity: numField(formData, 'quantity'),
    rationale: formData.get('rationale')?.toString() ?? '',
  });
  await createTradeDecision(parsed);
  revalidatePath('/stock/decisions');
}

/** 결과·교훈을 붙여 루프를 닫는다. */
export async function closeDecisionAction(id: string, formData: FormData) {
  const parsed = PatchTradeDecisionInput.parse({
    outcome: formData.get('outcome')?.toString() || null,
    lesson: formData.get('lesson')?.toString() || null,
  });
  await patchTradeDecision(id, parsed);
  revalidatePath('/stock/decisions');
}
