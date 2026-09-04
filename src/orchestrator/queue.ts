import PgBoss from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, pool, schema } from '../db/client.js';
import { log } from '../lib/logger.js';
import { notifyJobProblem, notifySubscriptionPause } from '../telegram/notify.js';
import { isRateLimitedError } from '../agents/types.js';
import { isJobSkippedError } from './jobSkipped.js';
import { withAgentWorkerGroup } from '../agents/semaphore.js';
import {
  LOGICAL_JOB_FIELD,
  getJobDefinition,
  isJobName,
  type JobName,
  type WorkerGroup,
} from './jobDefinitions.js';
import {
  ensureRequiredQueues,
  type QueueCreator,
} from './queueReadiness.js';
import {
  WorkflowRunStore,
  type EnqueueResult,
  type EnqueueMutation,
  type EnqueueTransactionPlanner,
} from './workflowRunStore.js';
import {
  failEnrichmentBranchInTransaction,
  type EnrichmentBranch,
} from './enrichmentBarrier.js';
import { businessTransitions } from './statuses.js';
import { isRunnerUnavailableError } from '../agents/types.js';

export type { JobName } from './jobDefinitions.js';
export type { EnqueueResult } from './workflowRunStore.js';

export interface JobPayload {
  campaignId?: string;
  businessId?: string;
  idempotencyKey?: string;
  [k: string]: unknown;
}

export type Handler = (payload: JobPayload) => Promise<void>;
export type HandlerRegistry = Readonly<Record<JobName, Handler>>;

let boss: PgBoss | null = null;

function enrichmentBranchFor(name: JobName): EnrichmentBranch | null {
  if (name === 'collect-assets') return 'assets';
  if (name === 'audit-website') return 'audit';
  return null;
}

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => log.error('pg-boss error', { err: String(err) }));
  await boss.start();
  return boss;
}

export type { QueueCreator } from './queueReadiness.js';

/** Create every current and target queue before any HTTP readiness is exposed. */
export async function ensureQueues(queueCreator?: QueueCreator): Promise<void> {
  const target = queueCreator ?? await getBoss();
  await ensureRequiredQueues(target);
}

export async function enqueue(
  name: JobName,
  payload: JobPayload,
  opts: { startAfterSeconds?: number; priority?: number } = {},
): Promise<EnqueueResult> {
  const b = await getBoss();
  const result = await new WorkflowRunStore(pool, b).enqueue({ name, payload, options: opts });
  log.info(result.kind === 'accepted' ? 'job enqueued' : 'duplicate job suppressed', {
    name,
    runId: result.runId,
    bossJobId: result.bossJobId,
    ...payload,
  });
  return result;
}

/** Enqueue a job and a related domain mutation on the same Postgres client. */
export async function enqueueWithMutation(
  name: JobName,
  payload: JobPayload,
  opts: { startAfterSeconds?: number; priority?: number },
  mutation: EnqueueMutation,
): Promise<EnqueueResult> {
  const b = await getBoss();
  const result = await new WorkflowRunStore(pool, b).enqueue(
    { name, payload, options: opts },
    mutation,
  );
  log.info(result.kind === 'accepted' ? 'job and domain mutation committed' : 'domain mutation committed with existing job', {
    name,
    runId: result.runId,
    bossJobId: result.bossJobId,
    ...payload,
  });
  return result;
}

/**
 * Commit a multi-write stage decision and all continuation jobs together.
 *
 * Workers use this boundary when the next payload depends on a row created in
 * the same transaction (for example a new site-project id), or when a stage
 * can legitimately finish without enqueueing a continuation.
 */
export async function commitWorkflow(
  plan: EnqueueTransactionPlanner,
): Promise<EnqueueResult[]> {
  const b = await getBoss();
  return new WorkflowRunStore(pool, b).enqueueTransaction(plan);
}

export async function processJob(
  name: JobName,
  job: PgBoss.Job<JobPayload>,
  handler: Handler,
  b: PgBoss,
): Promise<void> {
  const definition = getJobDefinition(name);
  const payload = job.data;
  const claim = await db.transaction(async (tx) => {
    const [jobRow] = await tx.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.bossJobId, job.id))
      .limit(1)
      .for('update');
    if (!jobRow) return null;
    if (jobRow.runId) {
      const [run] = await tx.select().from(schema.workflowJobRuns)
        .where(eq(schema.workflowJobRuns.id, jobRow.runId))
        .limit(1)
        .for('update');
      if (
        !run
        || run.currentAttemptSequence !== jobRow.attemptSequence
        || !['queued', 'retry_wait'].includes(run.status)
      ) return null;
    }
    const attempt = jobRow.attempts + 1;
    const claimed = await tx.update(schema.workflowJobs)
          .set({
            status: 'running', attempts: attempt, startedAt: new Date(),
            finishedAt: null, nextAttemptAt: null,
          })
      .where(and(
        eq(schema.workflowJobs.id, jobRow.id),
        eq(schema.workflowJobs.status, 'queued'),
      ))
      .returning({ id: schema.workflowJobs.id });
    if (!claimed.length) return null;
    if (jobRow.runId) {
      await tx.update(schema.workflowJobRuns)
        .set({ status: 'running', updatedAt: new Date(), finishedAt: null })
        .where(eq(schema.workflowJobRuns.id, jobRow.runId));
    }
    return { jobRow, attempt };
  });

  if (!claim) {
    log.warn('stale job delivery ignored', { name, bossJobId: job.id });
    return;
  }
  const { jobRow, attempt } = claim;

  try {
    await withAgentWorkerGroup(definition.workerGroup, () => handler(payload));
    const committed = await db.transaction(async (tx) => {
      const [currentAttempt] = await tx.select({
        status: schema.workflowJobs.status,
        runId: schema.workflowJobs.runId,
        attemptSequence: schema.workflowJobs.attemptSequence,
      })
        .from(schema.workflowJobs)
        .where(eq(schema.workflowJobs.id, jobRow.id))
        .limit(1)
        .for('update');
      if (currentAttempt?.status !== 'running') return false;
      if (currentAttempt.runId) {
        const [run] = await tx.select().from(schema.workflowJobRuns)
          .where(eq(schema.workflowJobRuns.id, currentAttempt.runId))
          .limit(1)
          .for('update');
        if (
          !run
          || run.status !== 'running'
          || run.currentAttemptSequence !== currentAttempt.attemptSequence
        ) return false;
      }
      const finishedAt = new Date();
      await tx.update(schema.workflowJobs)
        .set({ status: 'succeeded', finishedAt })
        .where(eq(schema.workflowJobs.id, jobRow.id));
      if (currentAttempt.runId) {
        await tx.update(schema.workflowJobRuns)
          .set({ status: 'succeeded', updatedAt: finishedAt, finishedAt })
          .where(eq(schema.workflowJobRuns.id, currentAttempt.runId));
      }
      return true;
    });
    if (!committed) log.warn('stale job success ignored', { name, bossJobId: job.id });
  } catch (err: any) {
    const detail = String(err?.stack ?? err).slice(0, 4000);

    // Nothing left to do: the project or business moved on while this attempt
    // was in flight. Recorded as its own outcome so the console never shows a
    // green «Готово» for work that did not happen, and never retried — the
    // state that made it pointless is not going to come back.
    if (isJobSkippedError(err)) {
      const reason = String(err.message).slice(0, 1_000);
      const skippedCommitted = await db.transaction(async (tx) => {
        const [currentAttempt] = await tx.select({
          status: schema.workflowJobs.status,
          runId: schema.workflowJobs.runId,
          attemptSequence: schema.workflowJobs.attemptSequence,
        })
          .from(schema.workflowJobs)
          .where(eq(schema.workflowJobs.id, jobRow.id))
          .limit(1)
          .for('update');
        if (currentAttempt?.status !== 'running') return false;
        const finishedAt = new Date();
        await tx.update(schema.workflowJobs)
          .set({ status: 'skipped', errorCode: 'SKIPPED', errorDetail: reason, finishedAt })
          .where(eq(schema.workflowJobs.id, jobRow.id));
        if (currentAttempt.runId) {
          await tx.update(schema.workflowJobRuns)
            .set({ status: 'skipped', updatedAt: finishedAt, finishedAt })
            .where(and(
              eq(schema.workflowJobRuns.id, currentAttempt.runId),
              eq(schema.workflowJobRuns.currentAttemptSequence, currentAttempt.attemptSequence ?? -1),
            ));
        }
        return true;
      });
      log.info(skippedCommitted ? 'job skipped: state moved on' : 'stale job skip ignored', {
        name, bossJobId: job.id, reason,
      });
      return;
    }

    // The agent runner is unreachable — typically the executor still coming up
    // after a deploy, or the gateway between restarts. That is a pause, not a
    // failed attempt: retrying three times in ninety seconds and then parking
    // the business on Roman's desk (BEAUTIFY Laser, 2026-09-04: «спроб: 4»,
    // RUNNER_UNAVAILABLE) turned every deploy into a decision. Back off and
    // resume on our own; the attempt budget stays untouched.
    const runnerDown = isRunnerUnavailableError(err);
    if (isRateLimitedError(err) || runnerDown) {
      const waitMs = runnerDown
        ? Math.min(10 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1))
        : err.retryAfterMs;
      const nextAttemptAt = new Date(Date.now() + waitMs);
      const errorCode = runnerDown ? 'RUNNER_UNAVAILABLE' as const : 'RATE_LIMITED' as const;
      const errorDetail = runnerDown
        ? `runner unavailable (${String(err.message).slice(0, 160)}); resumes ${nextAttemptAt.toISOString()}`
        : `subscription limit (${err.rateLimitType ?? 'unknown'}); resumes ${nextAttemptAt.toISOString()}`;
      const continuation = await new WorkflowRunStore(pool, b).continueAfterRateLimit({
        bossJobId: job.id,
        retryAfterMs: waitMs,
        errorDetail,
        nextAttemptAt,
        errorCode,
      });
      if (continuation.kind === 'stale') {
        log.warn('stale rate-limit result ignored', {
          name, bossJobId: job.id, runId: continuation.runId,
        });
        return;
      }
      if (continuation.kind === 'legacy') {
        const parked = await db.update(schema.workflowJobs)
          .set({
            status: 'retry_wait', attempts: Math.max(0, attempt - 1),
            nextAttemptAt, errorCode, errorDetail,
            finishedAt: new Date(),
          })
          .where(and(
            eq(schema.workflowJobs.id, jobRow.id),
            eq(schema.workflowJobs.status, 'running'),
          ))
          .returning({ id: schema.workflowJobs.id });
        if (parked.length) {
          await enqueue(
            name,
            { ...payload, idempotencyKey: jobRow.idempotencyKey ?? payload.idempotencyKey },
            { startAfterSeconds: Math.ceil(waitMs / 1000) },
          );
        }
      }
      log.warn(runnerDown ? 'job parked: agent runner unavailable' : 'job parked on subscription limit', {
        name, jobId: job.id,
        runId: continuation.kind === 'legacy' ? null : continuation.runId,
        successorJobId: continuation.kind === 'legacy' ? null : continuation.bossJobId,
        waitMinutes: Math.round(waitMs / 60_000),
        resumesAt: nextAttemptAt.toISOString(),
      });
      if (!runnerDown) {
        await notifySubscriptionPause({
          jobType: name, businessId: payload.businessId, resumesAt: nextAttemptAt,
          runtime: err.runtime,
        }).catch(() => {});
      }
      return;
    }
    const isFinalAttempt = attempt > definition.retry.limit;
    const needsHuman = err?.code === 'NEEDS_HUMAN';
    const failedCommitted = await db.transaction(async (tx) => {
      const attemptStatus = needsHuman ? 'needs_human' : (isFinalAttempt ? 'failed' : 'queued');
      const terminal = needsHuman || isFinalAttempt;
      const [currentAttempt] = await tx.select({
        status: schema.workflowJobs.status,
        runId: schema.workflowJobs.runId,
        attemptSequence: schema.workflowJobs.attemptSequence,
      })
        .from(schema.workflowJobs)
        .where(eq(schema.workflowJobs.id, jobRow.id))
        .limit(1)
        .for('update');
      if (currentAttempt?.status !== 'running') return false;
      if (currentAttempt.runId) {
        const [run] = await tx.select().from(schema.workflowJobRuns)
          .where(eq(schema.workflowJobRuns.id, currentAttempt.runId))
          .limit(1)
          .for('update');
        if (
          !run
          || run.status !== 'running'
          || run.currentAttemptSequence !== currentAttempt.attemptSequence
        ) return false;
      }
      const finishedAt = new Date();
      await tx.update(schema.workflowJobs)
        .set({
          status: attemptStatus,
          errorCode: err?.code ?? 'ERR',
          errorDetail: detail,
          finishedAt,
        })
        .where(eq(schema.workflowJobs.id, jobRow.id));
      if (currentAttempt.runId) {
        await tx.update(schema.workflowJobRuns)
          .set({
            status: attemptStatus,
            updatedAt: finishedAt,
            finishedAt: terminal ? finishedAt : null,
          })
          .where(eq(schema.workflowJobRuns.id, currentAttempt.runId));
      }
      const enrichmentBranch = enrichmentBranchFor(name);
      if (
        terminal
        && enrichmentBranch
        && typeof payload.enrichmentRunId === 'string'
        && typeof payload.businessId === 'string'
      ) {
        const [business] = await tx.select({ status: schema.businesses.status })
          .from(schema.businesses)
          .where(eq(schema.businesses.id, payload.businessId))
          .limit(1)
          .for('update');
        const branchFailure = await failEnrichmentBranchInTransaction(tx, {
          runId: payload.enrichmentRunId,
          businessId: payload.businessId,
          branch: enrichmentBranch,
          reason: `${name} ${needsHuman ? 'needs human' : 'retries exhausted'}: ${String(err?.message ?? err)}`
            .slice(0, 500),
        });
        if (branchFailure.kind === 'blocked' && branchFailure.changed && business?.status === 'enriching') {
          await businessTransitions.normalInTransaction(tx, {
            businessId: payload.businessId,
            expectedStatus: 'enriching',
            to: 'needs_review',
            actor: `${name}-lifecycle`,
            reason: `${name} could not complete its enrichment evidence branch`,
          });
        }
      }
      return true;
    });
    if (!failedCommitted) {
      log.warn('stale job failure ignored', { name, bossJobId: job.id });
      return;
    }
    log.error('job failed', { name, jobId: job.id, attempt, err: detail.slice(0, 500) });
    if (needsHuman || isFinalAttempt) {
      await notifyJobProblem({
        jobType: name,
        businessId: payload.businessId,
        campaignId: payload.campaignId,
        needsHuman,
        error: String(err?.message ?? err),
      }).catch(() => {});
    }
    if (!needsHuman) throw err;
  }
}

function logicalQueueHandler(name: JobName, handler: Handler, b: PgBoss): PgBoss.WorkHandler<JobPayload> {
  return async (jobs) => {
    for (const job of jobs) await processJob(name, job, handler, b);
  };
}

/** Register a logical queue (non-agent jobs and bounded legacy drainers). */
export async function register(name: JobName, handler: Handler): Promise<string> {
  const b = await getBoss();
  await b.createQueue(name);
  return b.work(name, { batchSize: 1, priority: true }, logicalQueueHandler(name, handler, b));
}

/** Dispatch a shared physical agent queue back to its typed logical handler. */
export function createAgentQueueHandler(
  group: WorkerGroup,
  handlers: HandlerRegistry,
  b: PgBoss,
): PgBoss.WorkHandler<JobPayload> {
  return async (jobs) => {
    for (const job of jobs) {
      const raw = job.data as JobPayload;
      const logicalName = raw[LOGICAL_JOB_FIELD];
      if (!isJobName(logicalName)) throw new Error(`agent queue job ${job.id} has no valid logical name`);
      const definition = getJobDefinition(logicalName);
      if (definition.workerGroup !== group || definition.agentCapability !== 'subscription') {
        throw new Error(`job ${logicalName} does not belong to agent-${group}`);
      }
      const { [LOGICAL_JOB_FIELD]: _logicalName, ...payload } = raw;
      await processJob(logicalName, { ...job, data: payload }, handlers[logicalName], b);
    }
  };
}

export class NeedsHumanError extends Error {
  code = 'NEEDS_HUMAN';
  constructor(msg: string) { super(msg); }
}
