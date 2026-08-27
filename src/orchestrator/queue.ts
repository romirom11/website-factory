import PgBoss from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, pool, schema } from '../db/client.js';
import { log } from '../lib/logger.js';
import { notifyJobProblem, notifySubscriptionPause } from '../telegram/notify.js';
import { isRateLimitedError } from '../agents/types.js';
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
} from './workflowRunStore.js';

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

    if (isRateLimitedError(err)) {
      const waitMs = err.retryAfterMs;
      const nextAttemptAt = new Date(Date.now() + waitMs);
      const errorDetail = `subscription limit (${err.rateLimitType ?? 'unknown'}); resumes ${nextAttemptAt.toISOString()}`;
      const continuation = await new WorkflowRunStore(pool, b).continueAfterRateLimit({
        bossJobId: job.id,
        retryAfterMs: waitMs,
        errorDetail,
        nextAttemptAt,
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
            nextAttemptAt, errorCode: 'RATE_LIMITED', errorDetail,
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
      log.warn('job parked on subscription limit', {
        name, jobId: job.id,
        runId: continuation.kind === 'legacy' ? null : continuation.runId,
        successorJobId: continuation.kind === 'legacy' ? null : continuation.bossJobId,
        waitMinutes: Math.round(waitMs / 60_000),
        resumesAt: nextAttemptAt.toISOString(),
      });
      await notifySubscriptionPause({
        jobType: name, businessId: payload.businessId, resumesAt: nextAttemptAt,
        runtime: err.runtime,
      }).catch(() => {});
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
