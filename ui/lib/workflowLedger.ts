import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from './db';

export interface WorkflowAttemptRef {
  runId: string | null;
  attemptSequence: number | null;
}

type UiTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Keep a linked logical run in lockstep with an operator-resolved attempt. */
export async function transitionCurrentRun(
  tx: UiTransaction,
  attempt: WorkflowAttemptRef,
  fromStatuses: readonly string[],
  toStatus: string,
  finishedAt: Date | null,
): Promise<void> {
  if (!attempt.runId) return;
  if (!attempt.attemptSequence) {
    throw new Error(`workflow run ${attempt.runId} has an attempt without a sequence`);
  }
  const updated = await tx.update(schema.workflowJobRuns).set({
    status: toStatus,
    updatedAt: new Date(),
    finishedAt,
  }).where(and(
    eq(schema.workflowJobRuns.id, attempt.runId),
    eq(schema.workflowJobRuns.currentAttemptSequence, attempt.attemptSequence),
    inArray(schema.workflowJobRuns.status, fromStatuses),
  )).returning({ id: schema.workflowJobRuns.id });
  if (!updated.length) {
    throw new Error(`workflow run ${attempt.runId} is no longer current for attempt ${attempt.attemptSequence}`);
  }
}
