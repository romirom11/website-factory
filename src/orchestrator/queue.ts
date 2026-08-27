import PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, pool, schema } from '../db/client.js';
import { log } from '../lib/logger.js';
import { notifyJobProblem, notifySubscriptionPause } from '../telegram/notify.js';
import { isRateLimitedError } from '../agents/types.js';
import {
  getJobDefinition,
  type JobName,
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

/** Wrap a handler with job-journal + error routing. One business failing never stops the campaign. */
export async function register(name: JobName, handler: Handler): Promise<void> {
  const definition = getJobDefinition(name);
  const b = await getBoss();
  await b.createQueue(name);
  // Agent jobs share one finite subscription window (SPEC §2.3а), so they are
  // capped rather than run wide. The cap follows AGENT_CONCURRENCY instead of
  // being pinned to 1: `src/agents/semaphore.ts` enforces the same number
  // in-process, so pulling more jobs than that would only park them on the
  // semaphore, while pulling fewer leaves configured capacity unused.
  const agentTeam = Math.max(1, config.agents.concurrency);
  const workOpts = definition.agentCapability === 'subscription'
    ? { batchSize: 1, teamSize: agentTeam, teamConcurrency: agentTeam }
    : { batchSize: 1 };
  await b.work(name, workOpts, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data as JobPayload;
      const [jobRow] = await db.select().from(schema.workflowJobs)
        .where(eq(schema.workflowJobs.bossJobId, job.id));
      const attempt = (jobRow?.attempts ?? 0) + 1;
      await db.transaction(async (tx) => {
        await tx.update(schema.workflowJobs)
          .set({
            status: 'running', attempts: attempt, startedAt: new Date(),
            finishedAt: null, nextAttemptAt: null,
          })
          .where(eq(schema.workflowJobs.bossJobId, job.id));
        if (jobRow?.runId) {
          await tx.update(schema.workflowJobRuns)
            .set({ status: 'running', updatedAt: new Date(), finishedAt: null })
            .where(eq(schema.workflowJobRuns.id, jobRow.runId));
        }
      });
      try {
        await handler(payload);
        await db.transaction(async (tx) => {
          const finishedAt = new Date();
          await tx.update(schema.workflowJobs)
            .set({ status: 'succeeded', finishedAt })
            .where(eq(schema.workflowJobs.bossJobId, job.id));
          if (jobRow?.runId) {
            await tx.update(schema.workflowJobRuns)
              .set({ status: 'succeeded', updatedAt: finishedAt, finishedAt })
              .where(eq(schema.workflowJobRuns.id, jobRow.runId));
          }
        });
      } catch (err: any) {
        const detail = String(err?.stack ?? err).slice(0, 4000);

        // SPEC §2.3(б): an exhausted subscription window is NOT a failure.
        // The job parks in `retry_wait`, is re-enqueued under the SAME
        // idempotency key once the window resets, and burns no attempt.
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
          // Bounded compatibility for an attempt created before migration. U3
          // reconciliation adopts live legacy rows before handlers register.
          if (continuation.kind === 'legacy') {
            await db.update(schema.workflowJobs)
              .set({
                status: 'retry_wait', attempts: Math.max(0, attempt - 1),
                nextAttemptAt, errorCode: 'RATE_LIMITED', errorDetail,
                finishedAt: new Date(),
              })
              .where(eq(schema.workflowJobs.bossJobId, job.id));
            await enqueue(
              name,
              { ...payload, idempotencyKey: jobRow?.idempotencyKey ?? payload.idempotencyKey },
              { startAfterSeconds: Math.ceil(waitMs / 1000) },
            );
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
          continue; // resolved for pg-boss: no failure, no auto-retry storm
        }
        const isFinalAttempt = attempt > definition.retry.limit;
        const needsHuman = err?.code === 'NEEDS_HUMAN';
        await db.transaction(async (tx) => {
          const attemptStatus = needsHuman ? 'needs_human' : (isFinalAttempt ? 'failed' : 'queued');
          const terminal = needsHuman || isFinalAttempt;
          const finishedAt = new Date();
          await tx.update(schema.workflowJobs)
            .set({
              status: attemptStatus,
              errorCode: err?.code ?? 'ERR',
              errorDetail: detail,
              finishedAt,
            })
            .where(eq(schema.workflowJobs.bossJobId, job.id));
          if (jobRow?.runId) {
            await tx.update(schema.workflowJobRuns)
              .set({
                status: attemptStatus,
                updatedAt: finishedAt,
                finishedAt: terminal ? finishedAt : null,
              })
              .where(eq(schema.workflowJobRuns.id, jobRow.runId));
          }
        });
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
        if (!needsHuman) throw err; // let pg-boss retry
      }
    }
  });
}

export class NeedsHumanError extends Error {
  code = 'NEEDS_HUMAN';
  constructor(msg: string) { super(msg); }
}
