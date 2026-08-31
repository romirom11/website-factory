import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { getJobDefinition, isJobName, type JobName } from './jobDefinitions.js';

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'retry_wait'] as const;
const LIVE_ATTEMPT_STATUSES = ['queued', 'running', 'retry_wait'] as const;
const LIVE_BOSS_STATES = ['created', 'retry', 'active'] as const;

type ReconciliationDatabase = NodePgDatabase<typeof schema>;

interface LegacyAttempt {
  id: number;
  bossJobId: string | null;
  jobType: string;
  businessId: string | null;
  campaignId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  bossState: string | null;
  bossQueue: string | null;
  bossCreatedAt: Date | string | null;
}

export interface LegacyReconciliationReport {
  adoptedRuns: number;
  cancelledDuplicates: number;
  parkedIncompatible: number;
}

function resolvedKey(row: LegacyAttempt): string {
  const payloadKey = row.payload?.idempotencyKey;
  if (row.idempotencyKey?.trim()) return row.idempotencyKey;
  if (typeof payloadKey === 'string' && payloadKey.trim()) return payloadKey;
  return row.businessId
    ? `${row.jobType}:${row.businessId}`
    : `${row.jobType}:${row.campaignId ?? 'global'}`;
}

function isLiveBoss(row: LegacyAttempt): boolean {
  return row.bossState !== null && LIVE_BOSS_STATES.includes(
    row.bossState as typeof LIVE_BOSS_STATES[number],
  );
}

function timestamp(value: Date | string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function winnerRank(row: LegacyAttempt): readonly [number, number, number] {
  const boss = row.bossState === 'active' ? 0 : row.bossState === 'retry' ? 1 : 2;
  const mirror = row.status === 'running' ? 0 : row.status === 'retry_wait' ? 1 : 2;
  return [boss, mirror, timestamp(row.bossCreatedAt ?? row.createdAt)];
}

function compareWinner(left: LegacyAttempt, right: LegacyAttempt): number {
  const a = winnerRank(left);
  const b = winnerRank(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || left.id - right.id;
}

function runStatus(row: LegacyAttempt): 'queued' | 'running' | 'retry_wait' {
  if (row.status === 'running' || row.bossState === 'active') return 'running';
  if (row.status === 'retry_wait') return 'retry_wait';
  return 'queued';
}

function compatibleQueue(name: JobName, queue: string | null): boolean {
  if (!queue) return false;
  const definition = getJobDefinition(name);
  return queue === name || queue === definition.physicalQueue;
}

/**
 * Adopt pre-workflow-run live attempts exactly once before consumers start.
 * The transaction-level advisory lock also protects split worker containers.
 */
export class LegacyJobReconciler {
  constructor(private readonly database: ReconciliationDatabase) {}

  async reconcile(): Promise<LegacyReconciliationReport> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('factory:legacy-job-reconcile'))`);
      const result = await tx.execute(sql`
        select
          w.id,
          w.boss_job_id as "bossJobId",
          w.job_type as "jobType",
          w.business_id as "businessId",
          w.campaign_id as "campaignId",
          w.idempotency_key as "idempotencyKey",
          w.payload,
          w.status,
          w.created_at as "createdAt",
          w.started_at as "startedAt",
          j.state::text as "bossState",
          j.name as "bossQueue",
          j.created_on as "bossCreatedAt"
        from workflow_jobs w
        left join pgboss.job j on j.id::text = w.boss_job_id
        where w.run_id is null
          and w.status in ('queued', 'running', 'retry_wait')
        order by w.id
        for update of w
      `);
      const rows = result.rows as unknown as LegacyAttempt[];
      const report: LegacyReconciliationReport = {
        adoptedRuns: 0,
        cancelledDuplicates: 0,
        parkedIncompatible: 0,
      };

      const groups = new Map<string, LegacyAttempt[]>();
      for (const row of rows) {
        if (!isLiveBoss(row)) continue;
        if (!isJobName(row.jobType) || !compatibleQueue(row.jobType, row.bossQueue)) {
          if (await this.cancelAttempt(tx, row, null, 'legacy_incompatible_needs_human', {
            reason: !isJobName(row.jobType) ? 'unknown job type' : 'unexpected physical queue',
            bossQueue: row.bossQueue,
          }, true, 'needs_human')) report.parkedIncompatible++;
          continue;
        }
        const key = resolvedKey(row);
        const groupKey = `${row.jobType}\u0000${key}`;
        const group = groups.get(groupKey) ?? [];
        group.push(row);
        groups.set(groupKey, group);
      }

      for (const liveRows of groups.values()) {
        const first = liveRows[0]!;
        const name = first.jobType as JobName;
        const key = resolvedKey(first);
        const siblings = rows.filter((row) => (
          row.jobType === name && resolvedKey(row) === key
        ));
        const activeDeliveries = liveRows.filter((row) => row.bossState === 'active');
        if (activeDeliveries.length > 1) {
          for (const sibling of siblings) {
            if (await this.cancelAttempt(
              tx,
              sibling,
              null,
              'legacy_ambiguous_active_needs_human',
              {
                reason: 'multiple active pg-boss deliveries share one idempotency key',
                conflictingBossJobIds: activeDeliveries.map((row) => row.bossJobId),
              },
              true,
              'needs_human',
            )) report.parkedIncompatible++;
          }
          continue;
        }
        const winner = [...liveRows].sort(compareWinner)[0]!;

        let [run] = await tx.select().from(schema.workflowJobRuns)
          .where(and(
            eq(schema.workflowJobRuns.jobType, name),
            eq(schema.workflowJobRuns.idempotencyKey, key),
            inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
          ))
          .limit(1)
          .for('update');

        let canonicalAttempt = run
          ? (await tx.select().from(schema.workflowJobs)
              .where(and(
                eq(schema.workflowJobs.runId, run.id),
                eq(schema.workflowJobs.attemptSequence, run.currentAttemptSequence),
              ))
              .limit(1)
              .for('update'))[0]
          : undefined;

        if (!run) {
          const runId = randomUUID();
          const [inserted] = await tx.insert(schema.workflowJobRuns).values({
            id: runId,
            jobType: name,
            idempotencyKey: key,
            businessId: winner.businessId,
            campaignId: winner.campaignId,
            status: runStatus(winner),
            currentAttemptSequence: 1,
            updatedAt: new Date(),
          }).onConflictDoNothing().returning();
          run = inserted ?? (await tx.select().from(schema.workflowJobRuns)
            .where(and(
              eq(schema.workflowJobRuns.jobType, name),
              eq(schema.workflowJobRuns.idempotencyKey, key),
              inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
            ))
            .limit(1)
            .for('update'))[0];
          if (!run) throw new Error(`failed to create or find canonical run for ${name}:${key}`);
        }

        if (!canonicalAttempt) {
          const sequence = run.currentAttemptSequence;
          const adoptedStatus = runStatus(winner);
          const [adopted] = await tx.update(schema.workflowJobs).set({
            runId: run.id,
            attemptSequence: sequence,
            idempotencyKey: key,
            status: adoptedStatus,
          }).where(and(
            eq(schema.workflowJobs.id, winner.id),
            isNull(schema.workflowJobs.runId),
            inArray(schema.workflowJobs.status, LIVE_ATTEMPT_STATUSES),
          )).returning();
          if (!adopted) throw new Error(`failed to adopt legacy attempt ${winner.id}`);
          canonicalAttempt = adopted;
          await tx.insert(schema.workflowReconciliationEvents).values({
            eventType: 'legacy_run_adopted',
            jobType: name,
            idempotencyKey: key,
            runId: run.id,
            attemptId: adopted.id,
            bossJobId: adopted.bossJobId,
            detail: {
              priorStatus: winner.status,
              bossState: winner.bossState,
              bossQueue: winner.bossQueue,
            },
          });
          report.adoptedRuns++;
        }

        for (const sibling of siblings) {
          if (sibling.id === canonicalAttempt.id) continue;
          const shouldCancelBoss = sibling.bossJobId !== canonicalAttempt.bossJobId;
          if (await this.cancelAttempt(
            tx,
            sibling,
            { runId: run.id, attemptId: canonicalAttempt.id, bossJobId: canonicalAttempt.bossJobId },
            'legacy_duplicate_cancelled',
            { reason: 'duplicate active idempotency key', shouldCancelBoss },
            shouldCancelBoss,
          )) report.cancelledDuplicates++;
        }
      }

      return report;
    });
  }

  private async cancelAttempt(
    tx: Parameters<Parameters<ReconciliationDatabase['transaction']>[0]>[0],
    row: LegacyAttempt,
    canonical: { runId: string; attemptId: number; bossJobId: string | null } | null,
    eventType: string,
    detail: Record<string, unknown>,
    cancelBoss = true,
    attemptStatus: 'cancelled' | 'needs_human' = 'cancelled',
  ): Promise<boolean> {
    const [cancelled] = await tx.update(schema.workflowJobs).set({
      status: attemptStatus,
      errorCode: attemptStatus === 'needs_human' ? 'RECONCILIATION_REQUIRED' : 'RECONCILED',
      errorDetail: canonical
        ? `Startup reconciliation retained attempt ${canonical.attemptId} for the canonical run.`
        : 'Startup reconciliation could not safely classify this legacy job; operator review is required.',
      finishedAt: new Date(),
    }).where(and(
      eq(schema.workflowJobs.id, row.id),
      isNull(schema.workflowJobs.runId),
      inArray(schema.workflowJobs.status, LIVE_ATTEMPT_STATUSES),
    )).returning({ id: schema.workflowJobs.id });
    if (!cancelled) return false;

    if (cancelBoss && row.bossJobId) {
      await tx.execute(sql`
        update pgboss.job
        set state = 'cancelled', completed_on = now()
        where id::text = ${row.bossJobId}
          and state::text in ('created', 'retry', 'active')
      `);
    }
    await tx.insert(schema.workflowReconciliationEvents).values({
      eventType,
      jobType: row.jobType,
      idempotencyKey: resolvedKey(row),
      runId: canonical?.runId ?? null,
      attemptId: row.id,
      bossJobId: row.bossJobId,
      detail: {
        ...detail,
        canonicalAttemptId: canonical?.attemptId ?? null,
        canonicalBossJobId: canonical?.bossJobId ?? null,
        priorStatus: row.status,
        bossState: row.bossState,
      },
    });
    return true;
  }
}
