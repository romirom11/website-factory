import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db, schema } from '../db/client.js';
import { enqueueWithMutation } from './queue.js';
import {
  BusinessTransitionService,
  requireBusinessStatus,
} from './statuses.js';
import { transitionCurrentRun } from './workflowLedger.js';
import type {
  EnqueueResult,
  WorkflowRunTransaction,
} from './workflowRunStore.js';

type BuildReviewDatabase = NodePgDatabase<typeof schema>;
type BuildReviewTransaction = WorkflowRunTransaction;

export type BuildReviewDecision = 'deploy_as_is' | 'another_iteration' | 'reject';

export interface BuildReviewDecisionInput {
  projectId: number;
  decision: BuildReviewDecision;
  reason: string;
  instruction?: string;
}

export type BuildReviewDecisionResult =
  | {
      kind: 'claimed';
      businessId: string;
      campaignId: string;
      projectId: number;
      decision: BuildReviewDecision;
      enqueueResult?: EnqueueResult;
    }
  | { kind: 'conflict'; message: string };

class BuildReviewConflictError extends Error {}

const PROJECT_TARGET = {
  deploy_as_is: 'ready',
  another_iteration: 'building',
  reject: 'failed',
} as const;

const BUSINESS_TARGET = {
  deploy_as_is: 'site_in_progress',
  another_iteration: 'site_in_progress',
  reject: 'rejected',
} as const;

const DECISION_LABEL = {
  deploy_as_is: 'задеплоїти як є',
  another_iteration: 'ще одна ітерація',
  reject: 'відхилити бізнес',
} as const;

/**
 * QA-iteration counter a build restarted by Roman begins from.
 *
 * The transaction resets `site_projects.qa_iterations` to this and the
 * successor build-site carries it as `iteration`; visual-qa applies its verdict
 * only when the two agree (`where qa_iterations = iteration`). They did not —
 * the job said 1, the row said 0 — so the critic's verdict after Roman's «ще
 * одна ітерація» was skipped as stale and the build sat in `qa` with no step
 * to follow, showing «перевіряє критик» for a week (BEAUTIFY Laser,
 * 2026-09-05 00:16). One constant, used by both.
 */
export const ANOTHER_ITERATION_START = 0;

/** The job a claimed decision hands to the queue — pure, so a test can pin it. */
export function reviewSuccessorJob(
  input: BuildReviewDecisionInput,
  businessId: string,
): {
  name: 'deploy-demo' | 'build-site';
  idempotencyKey: string;
  data: { projectId: number; iteration?: number; issues?: string[] };
} {
  if (input.decision === 'deploy_as_is') {
    return {
      name: 'deploy-demo',
      idempotencyKey: `deploy-demo:${businessId}:${input.projectId}`,
      data: { projectId: input.projectId },
    };
  }
  return {
    name: 'build-site',
    idempotencyKey: `build-site:${businessId}:${input.projectId}:roman:${Date.now()}`,
    data: {
      projectId: input.projectId,
      iteration: ANOTHER_ITERATION_START,
      issues: [`[high/roman] ${input.instruction?.trim() || input.reason}`],
    },
  };
}

/** Atomically claim exactly one operator decision for a parked QA build. */
export async function claimBuildReviewDecision(
  input: BuildReviewDecisionInput,
  database: BuildReviewDatabase = db,
): Promise<BuildReviewDecisionResult> {
  const transitions = new BusinessTransitionService(database);
  try {
    return await database.transaction(
      (tx) => claimBuildReviewDecisionInTransaction(input, tx, transitions),
    );
  } catch (error) {
    if (error instanceof BuildReviewConflictError) {
      return { kind: 'conflict', message: error.message };
    }
    throw error;
  }
}

/**
 * Production command: claim the review and create its successor job in the
 * same transaction used by pg-boss and the logical workflow ledger.
 */
export async function executeBuildReviewDecision(
  input: BuildReviewDecisionInput,
): Promise<BuildReviewDecisionResult> {
  if (input.decision === 'reject') return claimBuildReviewDecision(input);

  const [project] = await db.select({
    businessId: schema.siteProjects.businessId,
  }).from(schema.siteProjects)
    .where(eq(schema.siteProjects.id, input.projectId));
  if (!project) return { kind: 'conflict', message: 'Збірку не знайдено.' };
  const [business] = await db.select({
    campaignId: schema.businesses.campaignId,
  }).from(schema.businesses)
    .where(eq(schema.businesses.id, project.businessId));
  if (!business) return { kind: 'conflict', message: 'Бізнес не знайдено.' };

  const transitions = new BusinessTransitionService(db);
  let claimed: Extract<BuildReviewDecisionResult, { kind: 'claimed' }> | undefined;
  try {
    const job = reviewSuccessorJob(input, project.businessId);
    const enqueueResult = await enqueueWithMutation(
      job.name,
      {
        businessId: project.businessId,
        campaignId: business.campaignId,
        idempotencyKey: job.idempotencyKey,
        ...job.data,
      },
      {},
      async (tx) => {
        claimed = await claimBuildReviewDecisionInTransaction(input, tx, transitions);
      },
    );
    if (!claimed) throw new Error('build review transaction committed without its decision');
    return { ...claimed, enqueueResult };
  } catch (error) {
    if (error instanceof BuildReviewConflictError) {
      return { kind: 'conflict', message: error.message };
    }
    throw error;
  }
}

async function claimBuildReviewDecisionInTransaction(
  input: BuildReviewDecisionInput,
  tx: BuildReviewTransaction,
  transitions: BusinessTransitionService,
): Promise<Extract<BuildReviewDecisionResult, { kind: 'claimed' }>> {
  const [project] = await tx.select({
    id: schema.siteProjects.id,
    businessId: schema.siteProjects.businessId,
    state: schema.siteProjects.state,
  }).from(schema.siteProjects)
    .where(eq(schema.siteProjects.id, input.projectId));
  if (!project) throw new BuildReviewConflictError('Збірку не знайдено.');
  if (project.state !== 'needs_human_review') {
    throw new BuildReviewConflictError(`Ця збірка вже не чекає рішення (${project.state}).`);
  }

  const [business] = await tx.select({
    id: schema.businesses.id,
    campaignId: schema.businesses.campaignId,
    status: schema.businesses.status,
  }).from(schema.businesses)
    .where(eq(schema.businesses.id, project.businessId));
  if (!business) throw new BuildReviewConflictError('Бізнес не знайдено.');
  const expectedStatus = requireBusinessStatus(
    business.status,
    `business ${business.id}`,
  );
  if (expectedStatus !== 'needs_review') {
    throw new BuildReviewConflictError(
      `Рішення вже не актуальне: бізнес має статус ${expectedStatus}.`,
    );
  }

  const [projectClaim] = await tx.update(schema.siteProjects)
    .set({
      state: PROJECT_TARGET[input.decision],
      ...(input.decision === 'another_iteration' ? { qaIterations: ANOTHER_ITERATION_START } : {}),
    })
    .where(and(
      eq(schema.siteProjects.id, input.projectId),
      eq(schema.siteProjects.state, 'needs_human_review'),
    ))
    .returning({ id: schema.siteProjects.id });
  if (!projectClaim) throw new BuildReviewConflictError('Це рішення вже прийняли в іншій вкладці.');

  const transition = await transitions.overrideInTransaction(tx, {
    businessId: business.id,
    expectedStatus,
    to: BUSINESS_TARGET[input.decision],
    actor: 'roman',
    reason: input.reason,
  });
  if (transition.kind === 'conflict') {
    throw new BuildReviewConflictError(
      `Стан бізнесу вже змінився на ${transition.currentStatus}.`,
    );
  }

  const waitingAttempts = await tx.select({
    id: schema.workflowJobs.id,
    runId: schema.workflowJobs.runId,
    attemptSequence: schema.workflowJobs.attemptSequence,
  }).from(schema.workflowJobs).where(and(
    eq(schema.workflowJobs.jobType, 'visual-qa'),
    eq(schema.workflowJobs.status, 'needs_human'),
    sql`${schema.workflowJobs.payload}->>'projectId' = ${String(input.projectId)}`,
  )).for('update');
  const finishedAt = new Date();
  for (const attempt of waitingAttempts) {
    const [closed] = await tx.update(schema.workflowJobs)
      .set({
        status: 'cancelled',
        errorCode: null,
        errorDetail: `Роман вирішив QA-вердикт: ${DECISION_LABEL[input.decision]}`,
        finishedAt,
      })
      .where(and(
        eq(schema.workflowJobs.id, attempt.id),
        eq(schema.workflowJobs.status, 'needs_human'),
      ))
      .returning({ id: schema.workflowJobs.id });
    if (closed) {
      await transitionCurrentRun(
        tx,
        attempt,
        ['needs_human'],
        'cancelled',
        finishedAt,
      );
    }
  }

  return {
    kind: 'claimed',
    businessId: business.id,
    campaignId: business.campaignId,
    projectId: project.id,
    decision: input.decision,
  };
}

/** Atomically park the worker's QA verdict with its business state. */
export async function parkBuildForHumanReview(
  input: {
    projectId: number;
    businessId: string;
    reason: string;
    projectPatch?: Partial<Pick<
      typeof schema.siteProjects.$inferInsert,
      'qaIterations' | 'qaReportKey' | 'qaReportKeys' | 'screenshotKeys' | 'openIssues' | 'wowScores'
    >>;
  },
  database: BuildReviewDatabase = db,
): Promise<boolean> {
  const transitions = new BusinessTransitionService(database);
  try {
    return await database.transaction(async (tx) => {
      const [project] = await tx.update(schema.siteProjects)
        .set({ ...input.projectPatch, state: 'needs_human_review' })
        .where(and(
          eq(schema.siteProjects.id, input.projectId),
          eq(schema.siteProjects.businessId, input.businessId),
          eq(schema.siteProjects.state, 'qa'),
        ))
        .returning({ id: schema.siteProjects.id });
      if (!project) throw new BuildReviewConflictError('project already left QA');

      const transition = await transitions.normalInTransaction(tx, {
        businessId: input.businessId,
        expectedStatus: 'site_in_progress',
        to: 'needs_review',
        actor: 'visual-qa',
        reason: input.reason,
      });
      if (transition.kind === 'conflict') {
        throw new BuildReviewConflictError('business already left site_in_progress');
      }
      return true;
    });
  } catch (error) {
    if (error instanceof BuildReviewConflictError) return false;
    throw error;
  }
}
