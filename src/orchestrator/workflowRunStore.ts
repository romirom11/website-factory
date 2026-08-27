import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import {
  getJobDefinition,
  isJobName,
  jobQueuePriority,
  physicalJobData,
  validateJobPayload,
  type JobName,
} from './jobDefinitions.js';

export const ACTIVE_WORKFLOW_RUN_STATUSES = ['queued', 'running', 'retry_wait'] as const;
export type ActiveWorkflowRunStatus = typeof ACTIVE_WORKFLOW_RUN_STATUSES[number];

export interface WorkflowJobPayload extends Record<string, unknown> {
  campaignId?: string;
  businessId?: string;
  idempotencyKey?: string;
}

export interface EnqueueCommand {
  name: JobName;
  payload: WorkflowJobPayload;
  options?: {
    startAfterSeconds?: number;
    priority?: number;
  };
}

export type EnqueueResult =
  | {
      kind: 'accepted';
      runId: string;
      runStatus: 'queued';
      attemptId: number;
      attemptSequence: number;
      bossJobId: string;
    }
  | {
      kind: 'duplicate';
      runId: string;
      runStatus: ActiveWorkflowRunStatus;
      attemptId: number | null;
      attemptSequence: number;
      bossJobId: string | null;
    };

export type RateLimitContinuationResult =
  | {
      kind: 'scheduled' | 'existing';
      runId: string;
      attemptId: number;
      attemptSequence: number;
      bossJobId: string;
    }
  | { kind: 'legacy'; bossJobId: string }
  | { kind: 'stale'; runId: string | null; bossJobId: string };

export interface BossSender {
  send(name: string, data: object, options: PgBoss.SendOptions): Promise<string | null>;
}

type ConnectionPool = Pick<pg.Pool, 'connect'>;

function clientDb(client: pg.PoolClient): PgBoss.Db {
  return {
    executeSql: async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
}

function idempotencyKey(command: EnqueueCommand): string {
  return command.payload.idempotencyKey
    ?? (command.payload.businessId
      ? `${command.name}:${command.payload.businessId}`
      : `${command.name}:${command.payload.campaignId ?? 'global'}`);
}

function sendOptions(
  command: EnqueueCommand,
  bossJobId: string,
  key: string,
  db: PgBoss.Db,
): PgBoss.SendOptions {
  const definition = getJobDefinition(command.name);
  return {
    id: bossJobId,
    db,
    retryLimit: definition.retry.limit,
    retryDelay: definition.retry.delaySeconds,
    retryBackoff: true,
    expireInSeconds: definition.expireInSeconds,
    singletonKey: key,
    priority: jobQueuePriority(command.name, command.options?.priority),
    ...(command.options?.startAfterSeconds !== undefined
      ? { startAfter: command.options.startAfterSeconds }
      : {}),
  };
}

/**
 * Owns the transaction boundary between application job state and pg-boss.
 * The checked-out client is the only connection used until commit/rollback.
 */
export class WorkflowRunStore {
  constructor(
    private readonly pool: ConnectionPool,
    private readonly boss: BossSender,
  ) {}

  async enqueue(command: EnqueueCommand): Promise<EnqueueResult> {
    const validation = validateJobPayload(command.name, command.payload);
    if (!validation.ok) {
      throw new Error(`invalid ${command.name} payload: ${validation.issues.join('; ')}`);
    }

    const key = idempotencyKey(command);
    const runId = randomUUID();
    const bossJobId = randomUUID();
    const client = await this.pool.connect();
    const database = drizzle(client, { schema });

    try {
      return await database.transaction(async (tx) => {
        const insertedRuns = await tx.insert(schema.workflowJobRuns).values({
          id: runId,
          jobType: command.name,
          idempotencyKey: key,
          businessId: command.payload.businessId ?? null,
          campaignId: command.payload.campaignId ?? null,
          status: 'queued',
          currentAttemptSequence: 1,
        }).onConflictDoNothing().returning();

        if (!insertedRuns.length) {
          const [existingRun] = await tx.select().from(schema.workflowJobRuns)
            .where(and(
              eq(schema.workflowJobRuns.jobType, command.name),
              eq(schema.workflowJobRuns.idempotencyKey, key),
              inArray(schema.workflowJobRuns.status, ACTIVE_WORKFLOW_RUN_STATUSES),
            ))
            .limit(1);
          if (!existingRun) {
            throw new Error(`active workflow run conflict disappeared for ${command.name}:${key}`);
          }
          const [attempt] = await tx.select().from(schema.workflowJobs)
            .where(eq(schema.workflowJobs.runId, existingRun.id))
            .orderBy(desc(schema.workflowJobs.attemptSequence))
            .limit(1);
          return {
            kind: 'duplicate',
            runId: existingRun.id,
            runStatus: existingRun.status as ActiveWorkflowRunStatus,
            attemptId: attempt?.id ?? null,
            attemptSequence: existingRun.currentAttemptSequence,
            bossJobId: attempt?.bossJobId ?? null,
          };
        }

        const [attempt] = await tx.insert(schema.workflowJobs).values({
          bossJobId,
          jobType: command.name,
          businessId: command.payload.businessId ?? null,
          campaignId: command.payload.campaignId ?? null,
          payload: command.payload,
          idempotencyKey: key,
          runId,
          attemptSequence: 1,
          status: 'queued',
        }).returning({ id: schema.workflowJobs.id });
        if (!attempt) throw new Error(`failed to create first attempt for workflow run ${runId}`);

        const definition = getJobDefinition(command.name);
        const sentId = await this.boss.send(
          definition.physicalQueue,
          physicalJobData(command.name, command.payload),
          sendOptions(command, bossJobId, key, clientDb(client)),
        );
        if (sentId !== bossJobId) {
          throw new Error(`pg-boss did not create expected job ${bossJobId}`);
        }

        return {
          kind: 'accepted',
          runId,
          runStatus: 'queued',
          attemptId: attempt.id,
          attemptSequence: 1,
          bossJobId,
        };
      });
    } finally {
      client.release();
    }
  }

  /** Schedule exactly one successor physical attempt for a rate-limited run. */
  async continueAfterRateLimit(input: {
    bossJobId: string;
    retryAfterMs: number;
    errorDetail: string;
    nextAttemptAt: Date;
  }): Promise<RateLimitContinuationResult> {
    const client = await this.pool.connect();
    const database = drizzle(client, { schema });

    try {
      return await database.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.workflowJobs)
          .where(eq(schema.workflowJobs.bossJobId, input.bossJobId))
          .limit(1)
          .for('update');
        if (!current) {
          return {
            kind: 'stale',
            runId: null,
            bossJobId: input.bossJobId,
          };
        }
        if (!current?.runId || !current.attemptSequence) {
          return current.status === 'running'
            ? { kind: 'legacy', bossJobId: input.bossJobId }
            : { kind: 'stale', runId: null, bossJobId: input.bossJobId };
        }
        if (!isJobName(current.jobType)) {
          throw new Error(`unknown job type on attempt ${current.id}: ${current.jobType}`);
        }
        const [run] = await tx.select().from(schema.workflowJobRuns)
          .where(eq(schema.workflowJobRuns.id, current.runId))
          .limit(1)
          .for('update');
        const nextSequence = current.attemptSequence + 1;
        const [existing] = await tx.select().from(schema.workflowJobs)
          .where(and(
            eq(schema.workflowJobs.runId, current.runId),
            eq(schema.workflowJobs.attemptSequence, nextSequence),
          ))
          .limit(1);
        if (existing?.bossJobId) {
          if (
            !run
            || run.currentAttemptSequence !== nextSequence
            || !ACTIVE_WORKFLOW_RUN_STATUSES.includes(run.status as ActiveWorkflowRunStatus)
          ) return { kind: 'stale', runId: current.runId, bossJobId: input.bossJobId };
          return {
            kind: 'existing',
            runId: current.runId,
            attemptId: existing.id,
            attemptSequence: nextSequence,
            bossJobId: existing.bossJobId,
          };
        }
        if (
          current.status !== 'running'
          || !run
          || run.status !== 'running'
          || run.currentAttemptSequence !== current.attemptSequence
        ) {
          return { kind: 'stale', runId: current.runId, bossJobId: input.bossJobId };
        }

        const payload = (current.payload ?? {}) as WorkflowJobPayload;
        const key = current.idempotencyKey
          ?? payload.idempotencyKey
          ?? `${current.jobType}:${current.businessId ?? current.campaignId ?? 'global'}`;
        const successorBossId = randomUUID();
        const command: EnqueueCommand = {
          name: current.jobType,
          payload: { ...payload, idempotencyKey: key },
          options: { startAfterSeconds: Math.max(0, Math.ceil(input.retryAfterMs / 1000)) },
        };
        const validation = validateJobPayload(command.name, command.payload);
        if (!validation.ok) {
          throw new Error(`invalid continuation payload: ${validation.issues.join('; ')}`);
        }

        const [successor] = await tx.insert(schema.workflowJobs).values({
          bossJobId: successorBossId,
          jobType: current.jobType,
          businessId: current.businessId,
          campaignId: current.campaignId,
          payload: command.payload,
          idempotencyKey: key,
          runId: current.runId,
          attemptSequence: nextSequence,
          status: 'queued',
          nextAttemptAt: input.nextAttemptAt,
        }).returning({ id: schema.workflowJobs.id });
        if (!successor) throw new Error(`failed to create successor for workflow run ${current.runId}`);

        const definition = getJobDefinition(command.name);
        const sentId = await this.boss.send(
          definition.physicalQueue,
          physicalJobData(command.name, command.payload),
          sendOptions(command, successorBossId, key, clientDb(client)),
        );
        if (sentId !== successorBossId) {
          throw new Error(`pg-boss did not create successor ${successorBossId}`);
        }

        await tx.update(schema.workflowJobs).set({
          status: 'retry_wait',
          attempts: Math.max(0, current.attempts - 1),
          nextAttemptAt: input.nextAttemptAt,
          errorCode: 'RATE_LIMITED',
          errorDetail: input.errorDetail,
          finishedAt: new Date(),
        }).where(eq(schema.workflowJobs.id, current.id));
        await tx.update(schema.workflowJobRuns).set({
          status: 'retry_wait',
          currentAttemptSequence: nextSequence,
          updatedAt: new Date(),
        }).where(eq(schema.workflowJobRuns.id, current.runId));

        return {
          kind: 'scheduled',
          runId: current.runId,
          attemptId: successor.id,
          attemptSequence: nextSequence,
          bossJobId: successorBossId,
        };
      });
    } finally {
      client.release();
    }
  }
}
