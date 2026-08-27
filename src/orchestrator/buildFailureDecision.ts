import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db, schema } from '../db/client.js';
import {
  BusinessTransitionService,
  requireBusinessStatus,
} from './statuses.js';
import { transitionCurrentRun } from './workflowLedger.js';

type BuildDecisionDatabase = NodePgDatabase<typeof schema>;

export interface StopFailedBuildResult {
  ok: boolean;
  message: string;
  businessId?: string;
}

/**
 * Close a dead build without rejecting its business.
 *
 * Job attempt, logical run, project, business status and status history share
 * one transaction. The status write uses the same exact-state CAS as workers.
 */
export async function stopFailedBuild(
  jobId: number,
  database: BuildDecisionDatabase = db,
): Promise<StopFailedBuildResult> {
  const [job] = await database.select({
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
    database.select({
      id: schema.businesses.id,
      name: schema.businesses.name,
      status: schema.businesses.status,
    }).from(schema.businesses).where(eq(schema.businesses.id, job.businessId)),
    hasPayloadProject || job.jobType !== 'build-site'
      ? Promise.resolve([] as Array<{ id: number }>)
      : database.select({ id: schema.siteProjects.id })
        .from(schema.siteProjects)
        .where(and(
          eq(schema.siteProjects.businessId, job.businessId),
          inArray(schema.siteProjects.state, ['pending', 'brief', 'building', 'qa']),
        ))
        .orderBy(desc(schema.siteProjects.createdAt))
        .limit(1),
  ]);
  const business = businessRows[0];
  if (!business) return { ok: false, message: 'Бізнес не знайдено.' };
  const expectedStatus = requireBusinessStatus(
    business.status,
    `business ${business.id}`,
  );
  const projectId = hasPayloadProject ? payloadProjectId : fallbackProjects[0]?.id;
  const transitions = new BusinessTransitionService(database);

  const outcome = await database.transaction(async (tx) => {
    const finishedAt = new Date();
    const [closed] = await tx.update(schema.workflowJobs)
      .set({
        status: 'cancelled',
        errorCode: null,
        errorDetail: 'Роман зупинив цю збірку; бізнес повернуто до готового до демо',
        finishedAt,
      })
      .where(and(
        eq(schema.workflowJobs.id, jobId),
        inArray(schema.workflowJobs.status, ['failed', 'needs_human']),
      ))
      .returning({ id: schema.workflowJobs.id });
    if (!closed) return { claimed: false as const, transition: null };

    await transitionCurrentRun(
      tx,
      job,
      ['failed', 'needs_human'],
      'cancelled',
      finishedAt,
    );

    if (projectId) {
      await tx.update(schema.siteProjects)
        .set({ state: 'failed' })
        .where(and(
          eq(schema.siteProjects.id, projectId),
          eq(schema.siteProjects.businessId, business.id),
          inArray(schema.siteProjects.state, ['pending', 'brief', 'building', 'qa', 'failed']),
        ));
    }

    let transition = null;
    if (['site_in_progress', 'needs_review'].includes(expectedStatus)) {
      transition = await transitions.recoverInTransaction(tx, {
        businessId: business.id,
        expectedStatus,
        to: 'production_ready',
        reason: 'Роман зупинив невдалу збірку; бізнес не відхилено',
        actor: 'roman',
      });
    }
    return { claimed: true as const, transition };
  });

  if (!outcome.claimed) return { ok: false, message: 'Цю збірку щойно вже вирішили.' };
  if (outcome.transition?.kind === 'conflict') {
    return {
      ok: true,
      message: `${business.name}: збірку зупинено; новіший статус ${outcome.transition.currentStatus} не перезаписано`,
      businessId: business.id,
    };
  }
  return {
    ok: true,
    message: `${business.name}: збірку зупинено; бізнес лишився готовим до демо`,
    businessId: business.id,
  };
}
