import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from './db';
import { enqueueJob, type EnqueueInput, type EnqueueResult, type JobName } from './jobs';
import { transitionCurrentRun } from './workflowLedger';
import { factoryFetch } from './factoryApi';

type StopFailedBuildResult = { ok: boolean; message: string; businessId?: string };
export type RetryFailedJobOutcome = 'queued' | 'already_queued' | 'missing' | 'resolved';
type JobEnqueuer = (input: EnqueueInput) => Promise<EnqueueResult>;

/**
 * Re-run a failed attempt verbatim while competing safely with Stop.
 *
 * The conditional UPDATE is the decision lock: exactly one action can move the
 * row out of failed/needs_human. The injected enqueuer keeps this domain
 * decision independently testable without starting the factory or an agent.
 */
export async function retryFailedJob(
  jobId: number,
  enqueue: JobEnqueuer = enqueueJob,
): Promise<RetryFailedJobOutcome> {
  const [row] = await db.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, jobId));
  if (!row) return 'missing';

  const claimDetail = `Роман перезапускає цей крок (claim:${jobId})`;
  const claimedAt = new Date();
  const claimed = await db.transaction(async (tx) => {
    const [attempt] = await tx.update(schema.workflowJobs)
      .set({ status: 'cancelled', finishedAt: claimedAt, errorDetail: claimDetail })
      .where(and(
        eq(schema.workflowJobs.id, jobId),
        inArray(schema.workflowJobs.status, ['failed', 'needs_human']),
      ))
      .returning({
        id: schema.workflowJobs.id,
        runId: schema.workflowJobs.runId,
        attemptSequence: schema.workflowJobs.attemptSequence,
      });
    if (!attempt) return false;
    await transitionCurrentRun(
      tx, attempt, ['failed', 'needs_human'], 'cancelled', claimedAt,
    );
    return true;
  });
  if (!claimed) return 'resolved';

  const stored = (row.payload ?? {}) as Record<string, unknown>;
  const { businessId: _b, campaignId: _c, idempotencyKey: _k, ...rest } = stored;

  let enqueued: EnqueueResult;
  try {
    enqueued = await enqueue({
      name: row.jobType as JobName,
      businessId: row.businessId,
      campaignId: row.campaignId,
      idempotencyKey: row.idempotencyKey
        ?? `${row.jobType}:${row.businessId ?? 'global'}:retry:${Date.now()}`,
      data: rest,
    });
  } catch (error) {
    // The decision did not complete. Put the original attempt back exactly as
    // it was so it remains visible and retryable instead of disappearing.
    await db.transaction(async (tx) => {
      const [restored] = await tx.update(schema.workflowJobs)
        .set({ status: row.status, finishedAt: row.finishedAt, errorDetail: row.errorDetail })
        .where(and(
          eq(schema.workflowJobs.id, jobId),
          eq(schema.workflowJobs.status, 'cancelled'),
          eq(schema.workflowJobs.errorDetail, claimDetail),
        ))
        .returning({
          runId: schema.workflowJobs.runId,
          attemptSequence: schema.workflowJobs.attemptSequence,
        });
      if (restored) {
        await transitionCurrentRun(tx, restored, ['cancelled'], row.status, row.finishedAt);
      }
    });
    throw error;
  }

  await db.update(schema.workflowJobs)
    .set({
      errorDetail: enqueued.kind === 'accepted'
        ? 'Роман перезапустив цей крок — далі працює нова спроба'
        : 'Роман перезапустив цей крок; він уже стояв у черзі',
    })
    .where(and(
      eq(schema.workflowJobs.id, jobId),
      eq(schema.workflowJobs.status, 'cancelled'),
      eq(schema.workflowJobs.errorDetail, claimDetail),
    ));

  return enqueued.kind === 'accepted' ? 'queued' : 'already_queued';
}

/** The factory owns the composite job/project/business transaction. */
export async function stopFailedBuild(jobId: number): Promise<StopFailedBuildResult> {
  const response = await factoryFetch(
    `/internal/build-failures/${encodeURIComponent(String(jobId))}/stop`,
    { method: 'POST' },
  );
  return {
    ok: response.ok,
    message: response.message || (response.ok ? 'Збірку зупинено.' : 'Не вдалося зупинити збірку.'),
    ...(typeof response.body?.businessId === 'string'
      ? { businessId: response.body.businessId }
      : {}),
  };
}
