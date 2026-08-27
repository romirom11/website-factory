import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { transitionCurrentRun } from './workflowLedger';

/**
 * Close the workflow wait after Roman has made one of the three build decisions.
 *
 * Project state controls the pipeline; this row controls job reporting. Both
 * must advance, or the resolved QA verdict resurfaces as a fake retryable error.
 */
export async function closeVisualQaVerdict(projectId: number, decision: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select({
      id: schema.workflowJobs.id,
      runId: schema.workflowJobs.runId,
      attemptSequence: schema.workflowJobs.attemptSequence,
    }).from(schema.workflowJobs).where(and(
      eq(schema.workflowJobs.jobType, 'visual-qa'),
      eq(schema.workflowJobs.status, 'needs_human'),
      sql`${schema.workflowJobs.payload}->>'projectId' = ${String(projectId)}`,
    )).for('update');
    const finishedAt = new Date();
    for (const row of rows) {
      await tx.update(schema.workflowJobs)
        .set({
          status: 'cancelled',
          errorCode: null,
          errorDetail: `Роман вирішив QA-вердикт: ${decision}`,
          finishedAt,
        })
        .where(and(
          eq(schema.workflowJobs.id, row.id),
          eq(schema.workflowJobs.status, 'needs_human'),
        ));
      await transitionCurrentRun(tx, row, ['needs_human'], 'cancelled', finishedAt);
    }
  });
}
