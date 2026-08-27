import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from './db';
import { enqueueJob, type EnqueueInput, type EnqueueResult, type JobName } from './jobs';
import type { ActionResult } from './types';
import { transitionCurrentRun } from './workflowLedger';

type StopFailedBuildResult = ActionResult & { businessId?: string };
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

/**
 * Close a dead build without rejecting its business.
 *
 * All three records change in one transaction: the attempt is cancelled, the
 * half-built project becomes failed, and the business returns to
 * `production_ready`. Closing only the job would remove the card while leaving
 * the business stuck in `site_in_progress` forever.
 */
export async function stopFailedBuild(jobId: number): Promise<StopFailedBuildResult> {
  const [job] = await db.select({
    id: schema.workflowJobs.id,
    jobType: schema.workflowJobs.jobType,
    businessId: schema.workflowJobs.businessId,
    payload: schema.workflowJobs.payload,
    status: schema.workflowJobs.status,
    runId: schema.workflowJobs.runId,
    attemptSequence: schema.workflowJobs.attemptSequence,
  }).from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.id, jobId));
  if (!job) return { ok: false, message: 'Цей крок уже не знайти.' };
  if (!['content-and-design', 'build-site'].includes(job.jobType) || !job.businessId) {
    return { ok: false, message: 'Зупинити звідси можна лише збірку демосайту.' };
  }
  if (!['failed', 'needs_human'].includes(job.status)) {
    return { ok: false, message: 'Ця збірка вже не чекає рішення.' };
  }

  const payloadProjectId = Number((job.payload as Record<string, unknown> | null)?.projectId);
  const hasPayloadProject = Number.isFinite(payloadProjectId) && payloadProjectId > 0;
  const [businessRows, fallbackProjects] = await Promise.all([
    db.select({
      id: schema.businesses.id,
      name: schema.businesses.name,
      status: schema.businesses.status,
    }).from(schema.businesses).where(eq(schema.businesses.id, job.businessId)),
    hasPayloadProject || job.jobType !== 'build-site'
      ? Promise.resolve([] as Array<{ id: number }>)
      : db.select({ id: schema.siteProjects.id })
        .from(schema.siteProjects)
        .where(and(
          eq(schema.siteProjects.businessId, job.businessId),
          inArray(schema.siteProjects.state, ['pending', 'brief', 'building', 'qa']),
        ))
        .orderBy(desc(schema.siteProjects.createdAt))
        .limit(1),
  ]);
  const biz = businessRows[0];
  if (!biz) return { ok: false, message: 'Бізнес не знайдено.' };
  // Never attach a failed content/design attempt to an older deployed site.
  // A project belongs to this job only when its payload names it, or when a
  // legacy build-site row has exactly the newest still-active project to stop.
  const projectId = hasPayloadProject ? payloadProjectId : fallbackProjects[0]?.id;

  const stopped = await db.transaction(async (tx) => {
    const closed = await tx.update(schema.workflowJobs)
      .set({
        status: 'cancelled',
        errorCode: null,
        errorDetail: 'Роман зупинив цю збірку; бізнес повернуто до готового до демо',
        finishedAt: new Date(),
      })
      .where(and(
        eq(schema.workflowJobs.id, jobId),
        inArray(schema.workflowJobs.status, ['failed', 'needs_human']),
      ))
      .returning({ id: schema.workflowJobs.id });
    if (!closed.length) return false;
    await transitionCurrentRun(
      tx, job, ['failed', 'needs_human'], 'cancelled', new Date(),
    );

    if (projectId) {
      await tx.update(schema.siteProjects)
        .set({ state: 'failed' })
        .where(and(
          eq(schema.siteProjects.id, projectId),
          eq(schema.siteProjects.businessId, biz.id),
          inArray(schema.siteProjects.state, ['pending', 'brief', 'building', 'qa', 'failed']),
        ));
    }

    if (['site_in_progress', 'needs_review'].includes(biz.status)) {
      const moved = await tx.update(schema.businesses)
        .set({
          status: 'production_ready',
          statusReason: 'збірку зупинено Романом — можна запустити пізніше',
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.businesses.id, biz.id),
          eq(schema.businesses.status, biz.status),
        ))
        .returning({ id: schema.businesses.id });
      if (moved.length) {
        await tx.insert(schema.statusHistory).values({
          businessId: biz.id,
          fromStatus: biz.status,
          toStatus: 'production_ready',
          reason: 'Роман зупинив невдалу збірку; бізнес не відхилено',
          actor: 'roman',
        });
      }
    }
    return true;
  });

  if (!stopped) return { ok: false, message: 'Цю збірку щойно вже вирішили.' };
  return {
    ok: true,
    message: `${biz.name}: збірку зупинено; бізнес лишився готовим до демо`,
    businessId: biz.id,
  };
}
