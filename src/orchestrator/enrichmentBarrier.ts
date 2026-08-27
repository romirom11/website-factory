import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import {
  WorkflowRunStore,
  type EnqueueResult,
  type WorkflowRunTransaction,
} from './workflowRunStore.js';

export const ENRICHMENT_BRANCHES = ['assets', 'audit'] as const;
export type EnrichmentBranch = typeof ENRICHMENT_BRANCHES[number];
export type EnrichmentBranchOutcome = 'succeeded' | 'failed' | 'blocked';

export interface StartEnrichmentInput {
  businessId: string;
  campaignId: string;
  imageUrls?: unknown[];
}

export interface StartEnrichmentResult {
  runId: string;
  generation: number;
  jobs: EnqueueResult[];
}

export type LegacyEnrichmentAdoptionResult =
  | { kind: 'adopted'; runId: string; generation: number; campaignId: string }
  | { kind: 'conflict'; runId: string; generation: number; campaignId: string };

export type EnrichmentBranchAuthorization = 'run' | 'settled' | 'blocked' | 'stale';

export type EnrichmentBranchResult =
  | { kind: 'recorded'; runId: string; branch: EnrichmentBranch }
  | { kind: 'already_recorded'; runId: string; branch: EnrichmentBranch }
  | { kind: 'score_enqueued'; runId: string; branch: EnrichmentBranch; job: EnqueueResult }
  | { kind: 'blocked'; runId: string; branch: EnrichmentBranch; reason: string }
  | { kind: 'stale'; runId: string; branch: EnrichmentBranch };

export type ScoreCommitMutation = (tx: WorkflowRunTransaction) => Promise<void>;
export type BranchCommitMutation = (tx: WorkflowRunTransaction) => Promise<void>;

interface SettleBranchInput {
  runId: string;
  businessId: string;
  branch: EnrichmentBranch;
  outcome: EnrichmentBranchOutcome;
  reason?: string;
}

export interface EnrichmentBranchDecision {
  kind: Exclude<EnrichmentBranchResult['kind'], 'score_enqueued'> | 'enqueue_score';
  campaignId?: string;
  generation?: number;
  reason?: string;
  changed?: boolean;
}

function branchStatus(
  row: typeof schema.enrichmentRuns.$inferSelect,
  branch: EnrichmentBranch,
): string {
  return branch === 'assets' ? row.assetsStatus : row.auditStatus;
}

function branchPatch(
  branch: EnrichmentBranch,
  outcome: EnrichmentBranchOutcome,
): { assetsStatus: EnrichmentBranchOutcome } | { auditStatus: EnrichmentBranchOutcome } {
  return branch === 'assets' ? { assetsStatus: outcome } : { auditStatus: outcome };
}

/**
 * Apply one branch result while holding the barrier row lock. The caller owns
 * the surrounding transaction and, for the success join, the score enqueue.
 */
export async function settleEnrichmentBranchInTransaction(
  tx: WorkflowRunTransaction,
  input: SettleBranchInput,
): Promise<EnrichmentBranchDecision> {
  const [run] = await tx.select().from(schema.enrichmentRuns)
    .where(and(
      eq(schema.enrichmentRuns.id, input.runId),
      eq(schema.enrichmentRuns.businessId, input.businessId),
    ))
    .limit(1)
    .for('update');
  if (!run || run.status === 'superseded' || run.status === 'completed') {
    return { kind: 'stale' };
  }

  const currentBranchStatus = branchStatus(run, input.branch);
  if (currentBranchStatus === input.outcome) {
    return { kind: 'already_recorded' };
  }
  if (run.status === 'blocked') {
    if (currentBranchStatus === 'pending') {
      await tx.update(schema.enrichmentRuns)
        .set({ ...branchPatch(input.branch, input.outcome), updatedAt: new Date() })
        .where(eq(schema.enrichmentRuns.id, run.id));
      if (input.outcome === 'succeeded') return { kind: 'recorded' };
      return {
        kind: 'blocked',
        reason: run.blockingReason ?? input.reason ?? 'enrichment run is blocked',
        changed: true,
      };
    }
    return {
      kind: 'blocked',
      reason: run.blockingReason ?? 'enrichment run is blocked',
      changed: false,
    };
  }
  if (currentBranchStatus !== 'pending') {
    return {
      kind: 'blocked',
      reason: run.blockingReason ?? `${input.branch} already finished as ${currentBranchStatus}`,
      changed: false,
    };
  }

  const now = new Date();
  if (input.outcome !== 'succeeded') {
    const reason = input.reason?.trim() || `${input.branch} ${input.outcome}`;
    await tx.update(schema.enrichmentRuns)
      .set({
        ...branchPatch(input.branch, input.outcome),
        status: 'blocked',
        blockingReason: reason,
        updatedAt: now,
      })
      .where(eq(schema.enrichmentRuns.id, run.id));
    return { kind: 'blocked', reason, changed: true };
  }

  const otherSucceeded = input.branch === 'assets'
    ? run.auditStatus === 'succeeded'
    : run.assetsStatus === 'succeeded';
  if (!otherSucceeded) {
    await tx.update(schema.enrichmentRuns)
      .set({ ...branchPatch(input.branch, 'succeeded'), updatedAt: now })
      .where(eq(schema.enrichmentRuns.id, run.id));
    return { kind: 'recorded' };
  }

  await tx.update(schema.enrichmentRuns)
    .set({
      ...branchPatch(input.branch, 'succeeded'),
      status: 'score_enqueued',
      scoreEnqueuedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.enrichmentRuns.id, run.id));
  return {
    kind: 'enqueue_score',
    campaignId: run.campaignId,
    generation: run.generation,
  };
}

/** Durable two-branch join for one enrichment generation. */
export class EnrichmentBarrier {
  constructor(private readonly runStore: WorkflowRunStore) {}

  async start(input: StartEnrichmentInput): Promise<StartEnrichmentResult> {
    const runId = randomUUID();
    let generation = 0;
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select({ campaignId: schema.businesses.campaignId })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, input.businessId))
        .limit(1)
        .for('update');
      if (!business) throw new Error(`business not found: ${input.businessId}`);
      if (business.campaignId !== input.campaignId) {
        throw new Error(`campaign mismatch for business ${input.businessId}`);
      }

      const [latest] = await tx.select({ generation: schema.enrichmentRuns.generation })
        .from(schema.enrichmentRuns)
        .where(eq(schema.enrichmentRuns.businessId, input.businessId))
        .orderBy(desc(schema.enrichmentRuns.generation))
        .limit(1);
      generation = (latest?.generation ?? 0) + 1;
      const now = new Date();
      await tx.update(schema.enrichmentRuns)
        .set({ status: 'superseded', updatedAt: now, completedAt: now })
        .where(and(
          eq(schema.enrichmentRuns.businessId, input.businessId),
          inArray(schema.enrichmentRuns.status, ['running', 'score_enqueued']),
        ));
      await tx.insert(schema.enrichmentRuns).values({
        id: runId,
        businessId: input.businessId,
        campaignId: input.campaignId,
        generation,
      });

      const sharedPayload = {
        businessId: input.businessId,
        campaignId: input.campaignId,
        enrichmentRunId: runId,
        enrichmentGeneration: generation,
      };
      return [
        {
          name: 'collect-assets',
          payload: {
            ...sharedPayload,
            imageUrls: input.imageUrls ?? [],
            idempotencyKey: `collect-assets:${input.businessId}:enrichment:${runId}`,
          },
        },
        {
          name: 'audit-website',
          payload: {
            ...sharedPayload,
            idempotencyKey: `audit-website:${input.businessId}:enrichment:${runId}`,
          },
        },
      ];
    });
    return { runId, generation, jobs };
  }

  /**
   * Bounded compatibility for branch jobs created before migration 0017. Two
   * old branch deliveries may share a legacy run, but can never join or replace
   * a native generation created by the current orchestrator.
   */
  async adoptLegacyBranch(businessId: string): Promise<LegacyEnrichmentAdoptionResult> {
    let result: LegacyEnrichmentAdoptionResult | null = null;
    await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select({ campaignId: schema.businesses.campaignId })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) throw new Error(`business not found: ${businessId}`);

      const [current] = await tx.select().from(schema.enrichmentRuns)
        .where(and(
          eq(schema.enrichmentRuns.businessId, businessId),
          inArray(schema.enrichmentRuns.status, ['running', 'score_enqueued']),
        ))
        .limit(1)
        .for('update');
      if (current) {
        result = {
          kind: current.source === 'legacy' ? 'adopted' : 'conflict',
          runId: current.id,
          generation: current.generation,
          campaignId: current.campaignId,
        };
        return [];
      }

      const [latest] = await tx.select({ generation: schema.enrichmentRuns.generation })
        .from(schema.enrichmentRuns)
        .where(eq(schema.enrichmentRuns.businessId, businessId))
        .orderBy(desc(schema.enrichmentRuns.generation))
        .limit(1);
      const runId = randomUUID();
      const generation = (latest?.generation ?? 0) + 1;
      await tx.insert(schema.enrichmentRuns).values({
        id: runId,
        businessId,
        campaignId: business.campaignId,
        generation,
        source: 'legacy',
      });
      result = {
        kind: 'adopted',
        runId,
        generation,
        campaignId: business.campaignId,
      };
      return [];
    });
    if (!result) throw new Error(`legacy enrichment adoption produced no result for ${businessId}`);
    return result;
  }

  async completeBranch(
    input: Omit<SettleBranchInput, 'outcome' | 'reason'>,
    mutation?: BranchCommitMutation,
  ): Promise<EnrichmentBranchResult> {
    return this.settleBranch({ ...input, outcome: 'succeeded' }, mutation);
  }

  /** Avoid repeating expensive I/O for a settled or superseded delivery. */
  async authorizeBranch(input: {
    runId: string;
    businessId: string;
    branch: EnrichmentBranch;
  }): Promise<EnrichmentBranchAuthorization> {
    let authorization: EnrichmentBranchAuthorization = 'stale';
    await this.runStore.enqueueTransaction(async (tx) => {
      const [run] = await tx.select().from(schema.enrichmentRuns)
        .where(and(
          eq(schema.enrichmentRuns.id, input.runId),
          eq(schema.enrichmentRuns.businessId, input.businessId),
        ))
        .limit(1)
        .for('update');
      if (!run || run.status === 'superseded' || run.status === 'completed') return [];
      if (branchStatus(run, input.branch) !== 'pending') {
        authorization = 'settled';
      } else if (run.status === 'blocked') {
        authorization = 'blocked';
      } else if (run.status === 'running') {
        authorization = 'run';
      }
      return [];
    });
    return authorization;
  }

  async blockBranch(
    input: Omit<SettleBranchInput, 'outcome'> & { reason: string },
  ): Promise<EnrichmentBranchResult> {
    return this.settleBranch({ ...input, outcome: 'blocked' });
  }

  async isScoreCurrent(input: { runId: string; businessId: string }): Promise<boolean> {
    let current = false;
    await this.runStore.enqueueTransaction(async (tx) => {
      const [run] = await tx.select().from(schema.enrichmentRuns)
        .where(and(
          eq(schema.enrichmentRuns.id, input.runId),
          eq(schema.enrichmentRuns.businessId, input.businessId),
        ))
        .limit(1)
        .for('update');
      current = run?.status === 'score_enqueued'
        && run.assetsStatus === 'succeeded'
        && run.auditStatus === 'succeeded'
        && run.scoreEnqueuedAt !== null;
      return [];
    });
    return current;
  }

  async completeScore(input: { runId: string; businessId: string }): Promise<boolean> {
    return this.commitScore(input, async () => {});
  }

  /**
   * Commit score-owned evidence and close the barrier under the same locks.
   * Lock order matches `start` (business, then barrier) so a new generation can
   * never interleave with stale score writes.
   */
  async commitScore(
    input: { runId: string; businessId: string },
    mutation: ScoreCommitMutation,
  ): Promise<boolean> {
    let committed = false;
    await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select({ id: schema.businesses.id })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, input.businessId))
        .limit(1)
        .for('update');
      if (!business) throw new Error(`business not found: ${input.businessId}`);

      const [run] = await tx.select().from(schema.enrichmentRuns)
        .where(and(
          eq(schema.enrichmentRuns.id, input.runId),
          eq(schema.enrichmentRuns.businessId, input.businessId),
        ))
        .limit(1)
        .for('update');
      if (
        run?.status !== 'score_enqueued'
        || run.assetsStatus !== 'succeeded'
        || run.auditStatus !== 'succeeded'
        || run.scoreEnqueuedAt === null
      ) return [];

      await mutation(tx);
      const now = new Date();
      await tx.update(schema.enrichmentRuns)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(eq(schema.enrichmentRuns.id, input.runId));
      committed = true;
      return [];
    });
    return committed;
  }

  private async settleBranch(
    input: SettleBranchInput,
    mutation?: BranchCommitMutation,
  ): Promise<EnrichmentBranchResult> {
    let decision: EnrichmentBranchDecision = { kind: 'stale' };
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      decision = await settleEnrichmentBranchInTransaction(tx, input);
      if (decision.kind === 'recorded' || decision.kind === 'enqueue_score') {
        await mutation?.(tx);
      }
      if (decision.kind !== 'enqueue_score') return [];
      return [{
        name: 'score-and-qa',
        payload: {
          businessId: input.businessId,
          campaignId: decision.campaignId,
          enrichmentRunId: input.runId,
          enrichmentGeneration: decision.generation,
          idempotencyKey: `score-and-qa:${input.businessId}:enrichment:${input.runId}`,
        },
      }];
    });

    if (decision.kind === 'enqueue_score') {
      const job = jobs[0];
      if (!job) throw new Error(`score enqueue result missing for enrichment run ${input.runId}`);
      return { kind: 'score_enqueued', runId: input.runId, branch: input.branch, job };
    }
    if (decision.kind === 'blocked') {
      return {
        kind: 'blocked',
        runId: input.runId,
        branch: input.branch,
        reason: decision.reason ?? 'enrichment run blocked',
      };
    }
    return { kind: decision.kind, runId: input.runId, branch: input.branch };
  }
}

/** Join a terminal worker failure to its barrier in the worker lifecycle tx. */
export async function failEnrichmentBranchInTransaction(
  tx: WorkflowRunTransaction,
  input: Omit<SettleBranchInput, 'outcome'> & { reason: string },
): Promise<EnrichmentBranchDecision> {
  return settleEnrichmentBranchInTransaction(tx, { ...input, outcome: 'failed' });
}
