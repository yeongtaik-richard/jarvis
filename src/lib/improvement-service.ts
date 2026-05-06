import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { improvementNotes, type ImprovementNote } from '@/db/schema';
import { HttpError } from './errors';
import type {
  CreateImprovementInput,
  ImprovementSearchQuery,
  PatchImprovementInput,
} from './schemas';

export type ApiImprovement = {
  id: string;
  observed_request: string;
  missing_capability: string;
  proposed_fix: string | null;
  priority: number;
  status: 'open' | 'triaged' | 'applied' | 'wontfix';
  example_memory_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
};

export function toApiImprovement(n: ImprovementNote): ApiImprovement {
  return {
    id: n.id,
    observed_request: n.observedRequest,
    missing_capability: n.missingCapability,
    proposed_fix: n.proposedFix,
    priority: n.priority,
    status: n.status,
    example_memory_id: n.exampleMemoryId,
    created_at: n.createdAt.toISOString(),
    resolved_at: n.resolvedAt ? n.resolvedAt.toISOString() : null,
    resolution_note: n.resolutionNote,
  };
}

export async function createImprovement(
  input: CreateImprovementInput,
): Promise<ImprovementNote> {
  const [row] = await db
    .insert(improvementNotes)
    .values({
      observedRequest: input.observed_request,
      missingCapability: input.missing_capability,
      proposedFix: input.proposed_fix ?? null,
      priority: input.priority,
      exampleMemoryId: input.example_memory_id ?? null,
    })
    .returning();
  return row;
}

export async function getImprovementById(id: string): Promise<ImprovementNote | null> {
  const [row] = await db
    .select()
    .from(improvementNotes)
    .where(eq(improvementNotes.id, id))
    .limit(1);
  return row ?? null;
}

export async function searchImprovements(
  query: ImprovementSearchQuery,
): Promise<ImprovementNote[]> {
  const filters: SQL[] = [];
  if (query.status) filters.push(eq(improvementNotes.status, query.status));
  const whereExpr = filters.length ? and(...filters) : undefined;

  const base = db.select().from(improvementNotes);
  const filtered = whereExpr ? base.where(whereExpr) : base;
  return filtered
    .orderBy(desc(improvementNotes.priority), desc(improvementNotes.createdAt))
    .limit(query.limit);
}

export async function patchImprovement(
  id: string,
  input: PatchImprovementInput,
): Promise<ImprovementNote> {
  const patch: Partial<typeof improvementNotes.$inferInsert> = {};
  if (input.status !== undefined) {
    patch.status = input.status;
    if (input.status === 'applied' || input.status === 'wontfix') {
      patch.resolvedAt = new Date();
    }
  }
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.proposed_fix !== undefined) patch.proposedFix = input.proposed_fix ?? null;
  if (input.resolution_note !== undefined) patch.resolutionNote = input.resolution_note ?? null;

  if (Object.keys(patch).length === 0) {
    const existing = await getImprovementById(id);
    if (!existing) throw new HttpError(404, 'not_found');
    return existing;
  }

  const [row] = await db
    .update(improvementNotes)
    .set(patch)
    .where(eq(improvementNotes.id, id))
    .returning();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}
