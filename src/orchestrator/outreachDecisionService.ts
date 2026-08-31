import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import type { OutreachChannel } from '../channels/types.js';
import {
  followupIdempotencyKey,
  sendIdempotencyKey,
} from '../outreach/idempotency.js';
import {
  type EnqueueResult,
  type WorkflowRunStore,
} from './workflowRunStore.js';
import {
  BusinessTransitionService,
  requireBusinessStatus,
} from './statuses.js';

export type ApprovalDecisionConflict =
  | { kind: 'not_found'; entity: 'approval' | 'business' | 'message' }
  | { kind: 'already_decided'; decision: string }
  | { kind: 'state_conflict'; message: string };

export type ManualSendConflict =
  | { kind: 'not_found'; entity: 'approval' | 'business' | 'message' }
  | { kind: 'state_conflict'; message: string }
  | { kind: 'already_confirmed'; state: string };

export type ApproveOutreachResult = ApprovalDecisionConflict | {
  kind: 'approved';
  businessId: string;
  job: EnqueueResult;
};

export type RejectOutreachResult = ApprovalDecisionConflict | {
  kind: 'rejected';
  businessId: string;
};

export type ConfirmManualSendResult = ManualSendConflict | {
  kind: 'confirmed';
  businessId: string;
  followups: EnqueueResult[];
};

export interface ApproveOutreachInput {
  approvalId: number;
  channel: OutreachChannel;
  toAddress: string;
  subject: string | null;
  body: string;
}

type OutreachDecisionDatabase = NodePgDatabase<typeof schema>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function followupCommands(
  approvalId: number,
  businessId: string,
  channel: string,
  days: readonly number[],
) {
  return days.map((day, index) => ({
    name: 'send-followup' as const,
    payload: {
      businessId,
      followupIndex: index + 1,
      approvalId,
      channel,
      idempotencyKey: followupIdempotencyKey(approvalId, index + 1),
    },
    options: { startAfterSeconds: Math.max(0, Math.round(day * 24 * 60 * 60)) },
  }));
}

/**
 * Owns operator outreach decisions and their queue side effects.
 *
 * The supplied WorkflowRunStore makes domain writes and pg-boss sends share
 * one checked-out Postgres transaction. No UI or worker may reproduce this
 * sequence with independent writes.
 */
export class OutreachDecisionService {
  private readonly transitions: BusinessTransitionService;

  constructor(
    private readonly runStore: WorkflowRunStore,
    database: OutreachDecisionDatabase,
    private readonly followupDays: () => readonly number[],
  ) {
    this.transitions = new BusinessTransitionService(database);
  }

  async approve(input: ApproveOutreachInput): Promise<ApproveOutreachResult> {
    let conflict: ApprovalDecisionConflict = { kind: 'not_found', entity: 'approval' };
    let approvedBusinessId: string | null = null;
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [approval] = await tx.select().from(schema.approvals)
        .where(eq(schema.approvals.id, input.approvalId))
        .limit(1)
        .for('update');
      if (!approval) return [];
      if (approval.decision) {
        conflict = { kind: 'already_decided', decision: approval.decision };
        return [];
      }

      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, approval.businessId))
        .limit(1)
        .for('update');
      if (!business) {
        conflict = { kind: 'not_found', entity: 'business' };
        return [];
      }
      const status = requireBusinessStatus(business.status, `business ${approval.businessId}`);
      if (status !== 'site_ready') {
        conflict = {
          kind: 'state_conflict',
          message: `business must be site_ready, currently ${status}`,
        };
        return [];
      }

      const payload = {
        ...record(approval.payload),
        draft: {
          channel: input.channel,
          toAddress: input.toAddress,
          subject: input.subject,
          body: input.body,
        },
        approvedAt: new Date().toISOString(),
      };
      await tx.update(schema.approvals).set({
        decision: 'approved',
        decidedBy: 'roman',
        decidedAt: new Date(),
        payload,
      }).where(and(
        eq(schema.approvals.id, approval.id),
        eq(schema.approvals.businessId, approval.businessId),
      ));
      const transition = await this.transitions.normalInTransaction(tx, {
        businessId: approval.businessId,
        expectedStatus: 'site_ready',
        to: 'outreach_approved',
        actor: 'roman',
        reason: `approval #${approval.id}`,
      });
      if (transition.kind !== 'moved') {
        throw new Error(`approval ${approval.id} lost its locked business transition`);
      }
      approvedBusinessId = approval.businessId;
      return [{
        name: 'send-outreach',
        payload: {
          businessId: approval.businessId,
          approvalId: approval.id,
          idempotencyKey: sendIdempotencyKey(approval.id),
        },
      }];
    });

    if (approvedBusinessId) {
      const job = jobs[0];
      if (!job) throw new Error(`approval ${input.approvalId} committed without its send job`);
      return { kind: 'approved', businessId: approvedBusinessId, job };
    }
    return conflict;
  }

  async reject(approvalId: number, reason: string): Promise<RejectOutreachResult> {
    let result: RejectOutreachResult = { kind: 'not_found', entity: 'approval' };
    await this.runStore.enqueueTransaction(async (tx) => {
      const [approval] = await tx.select().from(schema.approvals)
        .where(eq(schema.approvals.id, approvalId))
        .limit(1)
        .for('update');
      if (!approval) return [];
      if (approval.decision) {
        result = { kind: 'already_decided', decision: approval.decision };
        return [];
      }
      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, approval.businessId))
        .limit(1)
        .for('update');
      if (!business) {
        result = { kind: 'not_found', entity: 'business' };
        return [];
      }
      const status = requireBusinessStatus(business.status, `business ${approval.businessId}`);
      if (status !== 'site_ready') {
        result = {
          kind: 'state_conflict',
          message: `business must be site_ready, currently ${status}`,
        };
        return [];
      }
      await tx.update(schema.approvals).set({
        decision: 'rejected',
        decidedBy: 'roman',
        decidedAt: new Date(),
      }).where(eq(schema.approvals.id, approval.id));
      const transition = await this.transitions.normalInTransaction(tx, {
        businessId: approval.businessId,
        expectedStatus: 'site_ready',
        to: 'rejected',
        actor: 'roman',
        reason,
      });
      if (transition.kind !== 'moved') {
        throw new Error(`rejection ${approval.id} lost its locked business transition`);
      }
      result = { kind: 'rejected', businessId: approval.businessId };
      return [];
    });
    return result;
  }

  async confirmManualSend(approvalId: number): Promise<ConfirmManualSendResult> {
    let conflict: ManualSendConflict = { kind: 'not_found', entity: 'approval' };
    let confirmedBusinessId: string | null = null;
    const days = [...this.followupDays()];
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [approval] = await tx.select().from(schema.approvals)
        .where(eq(schema.approvals.id, approvalId))
        .limit(1)
        .for('update');
      if (!approval) return [];
      if (approval.decision !== 'approved') {
        conflict = {
          kind: 'state_conflict',
          message: `approval must be approved, currently ${approval.decision ?? 'pending'}`,
        };
        return [];
      }

      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, approval.businessId))
        .limit(1)
        .for('update');
      if (!business) {
        conflict = { kind: 'not_found', entity: 'business' };
        return [];
      }
      const [message] = await tx.select().from(schema.outreachMessages)
        .where(eq(schema.outreachMessages.idempotencyKey, sendIdempotencyKey(approval.id)))
        .limit(1)
        .for('update');
      if (!message || message.businessId !== approval.businessId) {
        conflict = { kind: 'not_found', entity: 'message' };
        return [];
      }
      if (message.state !== 'manual_pending') {
        conflict = { kind: 'already_confirmed', state: message.state };
        return [];
      }
      const status = requireBusinessStatus(business.status, `business ${approval.businessId}`);
      if (status !== 'outreach_approved') {
        conflict = {
          kind: 'state_conflict',
          message: `business must be outreach_approved, currently ${status}`,
        };
        return [];
      }

      const now = new Date();
      await tx.update(schema.outreachMessages)
        .set({ state: 'sent', sentAt: now })
        .where(eq(schema.outreachMessages.id, message.id));
      await tx.insert(schema.outreachEvents).values({
        businessId: approval.businessId,
        messageId: message.id,
        event: 'sent',
        detail: { channel: message.channel, manualConfirmation: true, actor: 'roman' },
      });
      const transition = await this.transitions.normalInTransaction(tx, {
        businessId: approval.businessId,
        expectedStatus: 'outreach_approved',
        to: 'contacted',
        actor: 'roman',
        reason: `${message.channel} sent manually`,
      });
      if (transition.kind !== 'moved') {
        throw new Error(`manual confirmation ${approval.id} lost its locked business transition`);
      }
      await tx.insert(schema.deals).values({
        businessId: approval.businessId,
        state: 'contacted',
      }).onConflictDoNothing();
      confirmedBusinessId = approval.businessId;
      return followupCommands(
        approval.id,
        approval.businessId,
        message.channel,
        days,
      );
    });

    return confirmedBusinessId
      ? { kind: 'confirmed', businessId: confirmedBusinessId, followups: jobs }
      : conflict;
  }
}
