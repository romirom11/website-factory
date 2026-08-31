import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import { normalizeDoNotContactValue } from '../outreach/doNotContact.js';
import {
  BusinessTransitionService,
  requireBusinessStatus,
} from './statuses.js';
import type { WorkflowRunTransaction } from './workflowRunStore.js';

const ACTIVE_JOB_STATUSES = ['queued', 'retry_wait'] as const;
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'retry_wait'] as const;
const REPLY_STATES_TO_PRESERVE = new Set([
  'meeting', 'proposal', 'won', 'lost', 'closed', 'do_not_contact',
]);

type InboundDatabase = NodePgDatabase<typeof schema>;

interface InboundEventInput {
  businessId: string;
  messageId: number | null;
  idempotencyKey?: string | null;
}

export interface OptOutInput extends InboundEventInput {
  channel: string;
  fromAddress: string;
  phrase: string;
}

export interface BounceInput extends InboundEventInput {
  channel: string;
  fromAddress: string;
  reason: string;
  bouncedAddress?: string | null;
}

export interface ReplyInput extends InboundEventInput {
  channel: string;
  detail: Record<string, unknown>;
}

export interface InboundMutationResult {
  applied: boolean;
  cancelledFollowups: number;
  businessName?: string | null;
}

/** Commits each inbound outcome and its logical follow-up cancellations once. */
export class InboundOutreachService {
  private readonly transitions: BusinessTransitionService;

  constructor(
    private readonly database: InboundDatabase,
    private readonly cancelPhysicalJobs: (bossJobIds: readonly string[]) => Promise<void>,
  ) {
    this.transitions = new BusinessTransitionService(database);
  }

  async cancelFollowups(businessId: string, reason: string): Promise<number> {
    const bossJobIds = await this.database.transaction(
      (tx) => this.cancelFollowupsInTransaction(tx, businessId, reason),
    );
    await this.cancelPhysicalBestEffort(bossJobIds);
    return bossJobIds.length;
  }

  async recordOptOut(input: OptOutInput): Promise<InboundMutationResult> {
    const result = await this.database.transaction(async (tx) => {
      if (!await this.claimEvent(tx, {
        ...input,
        event: 'opted_out',
        detail: {
          channel: input.channel,
          phrase: input.phrase,
          from: input.fromAddress,
        },
      })) return { applied: false, bossJobIds: [] as string[] };

      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, input.businessId))
        .limit(1)
        .for('update');
      if (!business) throw new Error(`business not found: ${input.businessId}`);
      const status = requireBusinessStatus(business.status, `business ${input.businessId}`);
      const matchType = input.channel === 'email' ? 'email' : 'phone';
      const address = normalizeDoNotContactValue(matchType, input.fromAddress);
      const reason = `opt-out via ${input.channel}: "${input.phrase}"`;
      await tx.insert(schema.doNotContact).values([
        ...(address ? [{ matchType, value: address, reason }] : []),
        { matchType: 'business_id', value: input.businessId, reason },
      ]).onConflictDoNothing();
      const transition = await this.transitions.overrideInTransaction(tx, {
        businessId: input.businessId,
        expectedStatus: status,
        to: 'do_not_contact',
        actor: 'replies-worker',
        reason: `opt-out via ${input.channel}`,
      });
      if (transition.kind === 'conflict') {
        throw new Error(`opt-out lost its locked transition for ${input.businessId}`);
      }
      const bossJobIds = await this.cancelFollowupsInTransaction(
        tx,
        input.businessId,
        'opt-out',
      );
      return { applied: true, bossJobIds };
    });
    await this.cancelPhysicalBestEffort(result.bossJobIds);
    return {
      applied: result.applied,
      cancelledFollowups: result.bossJobIds.length,
    };
  }

  async recordBounce(input: BounceInput): Promise<InboundMutationResult> {
    const result = await this.database.transaction(async (tx) => {
      if (!await this.claimEvent(tx, {
        ...input,
        event: 'bounced',
        detail: {
          channel: input.channel,
          reason: input.reason,
          bouncedAddress: input.bouncedAddress ?? null,
          from: input.fromAddress,
        },
      })) return { applied: false, bossJobIds: [] as string[] };

      if (input.messageId) {
        await tx.update(schema.outreachMessages).set({ state: 'failed' })
          .where(eq(schema.outreachMessages.id, input.messageId));
      }
      const bossJobIds = await this.cancelFollowupsInTransaction(
        tx,
        input.businessId,
        'bounce',
      );
      return { applied: true, bossJobIds };
    });
    await this.cancelPhysicalBestEffort(result.bossJobIds);
    return {
      applied: result.applied,
      cancelledFollowups: result.bossJobIds.length,
    };
  }

  async recordReply(input: ReplyInput): Promise<InboundMutationResult> {
    const result = await this.database.transaction(async (tx) => {
      if (!await this.claimEvent(tx, {
        ...input,
        event: 'replied',
        detail: input.detail,
      })) {
        return { applied: false, bossJobIds: [] as string[], businessName: null };
      }

      const [business] = await tx.select({
        name: schema.businesses.name,
        status: schema.businesses.status,
      }).from(schema.businesses)
        .where(eq(schema.businesses.id, input.businessId))
        .limit(1)
        .for('update');
      if (!business) throw new Error(`business not found: ${input.businessId}`);
      const status = requireBusinessStatus(business.status, `business ${input.businessId}`);
      if (status === 'replied' || !REPLY_STATES_TO_PRESERVE.has(status)) {
        if (status !== 'replied') {
          const reason = `reply via ${input.channel}`;
          const transition = status === 'contacted'
            ? await this.transitions.normalInTransaction(tx, {
                businessId: input.businessId,
                expectedStatus: status,
                to: 'replied',
                actor: 'replies-worker',
                reason,
              })
            : await this.transitions.overrideInTransaction(tx, {
                businessId: input.businessId,
                expectedStatus: status,
                to: 'replied',
                actor: 'replies-worker',
                reason: `${reason}; reply arrived outside the expected contacted state`,
              });
          if (transition.kind !== 'moved') {
            throw new Error(`reply lost its locked transition for ${input.businessId}`);
          }
        }
        await tx.insert(schema.deals).values({
          businessId: input.businessId,
          state: 'replied',
        }).onConflictDoUpdate({
          target: schema.deals.businessId,
          set: { state: 'replied', updatedAt: new Date() },
        });
      }
      const bossJobIds = await this.cancelFollowupsInTransaction(
        tx,
        input.businessId,
        'reply',
      );
      return { applied: true, bossJobIds, businessName: business.name };
    });
    await this.cancelPhysicalBestEffort(result.bossJobIds);
    return {
      applied: result.applied,
      cancelledFollowups: result.bossJobIds.length,
      businessName: result.businessName,
    };
  }

  private async claimEvent(
    tx: WorkflowRunTransaction,
    input: InboundEventInput & { event: string; detail: Record<string, unknown> },
  ): Promise<boolean> {
    const inserted = await tx.insert(schema.outreachEvents).values({
      businessId: input.businessId,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey ?? null,
      event: input.event,
      detail: input.detail,
    }).onConflictDoNothing({
      target: schema.outreachEvents.idempotencyKey,
    }).returning({ id: schema.outreachEvents.id });
    return inserted.length > 0;
  }

  private async cancelFollowupsInTransaction(
    tx: WorkflowRunTransaction,
    businessId: string,
    reason: string,
  ): Promise<string[]> {
    const rows = await tx.select({
      id: schema.workflowJobs.id,
      runId: schema.workflowJobs.runId,
      bossJobId: schema.workflowJobs.bossJobId,
    }).from(schema.workflowJobs)
      .where(and(
        eq(schema.workflowJobs.jobType, 'send-followup'),
        eq(schema.workflowJobs.businessId, businessId),
        inArray(schema.workflowJobs.status, ACTIVE_JOB_STATUSES),
      ))
      .for('update');
    if (!rows.length) return [];

    const now = new Date();
    await tx.update(schema.workflowJobs).set({
      status: 'cancelled',
      errorCode: 'INBOUND_CANCELLED',
      errorDetail: `cancelled: ${reason}`,
      finishedAt: now,
    }).where(inArray(schema.workflowJobs.id, rows.map((row) => row.id)));
    const runIds = [...new Set(rows.flatMap((row) => row.runId ? [row.runId] : []))];
    if (runIds.length) {
      await tx.update(schema.workflowJobRuns).set({
        status: 'cancelled',
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        inArray(schema.workflowJobRuns.id, runIds),
        inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
      ));
    }
    return rows.flatMap((row) => row.bossJobId ? [row.bossJobId] : []);
  }

  private async cancelPhysicalBestEffort(bossJobIds: readonly string[]): Promise<void> {
    if (!bossJobIds.length) return;
    try {
      await this.cancelPhysicalJobs(bossJobIds);
    } catch (error) {
      // Logical cancellation is the safety boundary. A physical delivery that
      // escaped cancellation is rejected by processJob and the inbound gates.
      log.warn('physical follow-up cancellation failed after logical commit', {
        count: bossJobIds.length,
        err: String(error),
      });
    }
  }
}
