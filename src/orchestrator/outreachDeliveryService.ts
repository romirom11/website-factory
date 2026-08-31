import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  AUTOMATED_CHANNELS,
  type OutreachChannel,
  type SendResult,
} from '../channels/types.js';
import * as schema from '../db/schema.js';
import { createFollowupCommands } from '../outreach/followups.js';
import type {
  EnqueueResult,
  EnqueueTransactionPlanner,
} from './workflowRunStore.js';
import {
  BusinessTransitionService,
  requireBusinessStatus,
} from './statuses.js';

const FINAL_COUNTED_DELIVERY_STATES = [
  'sent',
  'delivered',
  'simulated',
  'delivery_unknown',
] as const;

type OutreachDeliveryDatabase = NodePgDatabase<typeof schema>;
type WorkflowCommit = (
  plan: EnqueueTransactionPlanner,
) => Promise<EnqueueResult[]>;
type DeliveryState = SendResult['state'];

export type MessageReservation =
  | { kind: 'reserved'; messageId: number }
  | { kind: 'duplicate'; messageId: number; state: string }
  | { kind: 'daily_limit'; current: number; limit: number };

export interface ReserveMessageInput {
  businessId: string;
  channel: OutreachChannel;
  toAddress: string;
  subject: string | null;
  body: string;
  idempotencyKey: string;
  messageKind: 'initial' | `followup_${number}`;
  dailyLimit: number;
}

export interface FinalizeInitialInput {
  messageId: number;
  businessId: string;
  approvalId: number;
  channel: OutreachChannel;
  state: DeliveryState;
  providerMessageId: string | null;
  mode: 'dry_run' | 'live';
}

export interface FinalizeFollowupInput {
  messageId: number;
  businessId: string;
  followupIndex: number;
  channel: OutreachChannel;
  state: DeliveryState;
  providerMessageId: string | null;
  mode: 'dry_run' | 'live';
}

export type InitialFinalizationResult = {
  kind: 'finalized';
  businessAdvanced: boolean;
  followups: EnqueueResult[];
} | {
  kind: 'already_finalized';
  state: string;
};

/**
 * Owns the durable boundary around outreach delivery.
 *
 * The transport call intentionally remains outside Postgres. Before it runs,
 * this service reserves one immutable message intent and one daily-budget
 * slot. Afterwards it commits every local consequence in one transaction.
 */
export class OutreachDeliveryService {
  private readonly transitions: BusinessTransitionService;

  constructor(
    private readonly commit: WorkflowCommit,
    database: OutreachDeliveryDatabase,
    private readonly followupDays: () => readonly number[],
  ) {
    this.transitions = new BusinessTransitionService(database);
  }

  async reserveMessage(input: ReserveMessageInput): Promise<MessageReservation> {
    let result: MessageReservation | null = null;
    const automated = AUTOMATED_CHANNELS.has(input.channel);
    await this.commit(async (tx) => {
      if (automated) {
        // One transaction at a time may observe and reserve the global budget.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('outreach-daily-budget', 0))`);
      }

      const [existing] = await tx.select({
        id: schema.outreachMessages.id,
        state: schema.outreachMessages.state,
      }).from(schema.outreachMessages)
        .where(eq(schema.outreachMessages.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .for('update');
      if (existing && existing.state !== 'failed') {
        result = {
          kind: 'duplicate',
          messageId: existing.id,
          state: existing.state,
        };
        return [];
      }

      if (automated) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [row] = await tx.select({ count: sql<number>`count(*)` })
          .from(schema.outreachMessages)
          .where(and(
            inArray(schema.outreachMessages.channel, [...AUTOMATED_CHANNELS]),
            or(
              and(
                eq(schema.outreachMessages.state, 'queued'),
                gte(schema.outreachMessages.createdAt, since),
              ),
              and(
                inArray(
                  schema.outreachMessages.state,
                  FINAL_COUNTED_DELIVERY_STATES,
                ),
                gte(schema.outreachMessages.sentAt, since),
              ),
            ),
          ));
        const current = Number(row?.count ?? 0);
        if (current >= input.dailyLimit) {
          result = { kind: 'daily_limit', current, limit: input.dailyLimit };
          return [];
        }
      }

      if (existing) {
        const [reclaimed] = await tx.update(schema.outreachMessages).set({
          state: 'queued',
          providerMessageId: null,
          sentAt: null,
          createdAt: new Date(),
        }).where(and(
          eq(schema.outreachMessages.id, existing.id),
          eq(schema.outreachMessages.state, 'failed'),
        )).returning({ id: schema.outreachMessages.id });
        if (!reclaimed) {
          throw new Error(`failed outreach reservation changed while locked: ${existing.id}`);
        }
        result = { kind: 'reserved', messageId: reclaimed.id };
        return [];
      }

      const [inserted] = await tx.insert(schema.outreachMessages).values({
        businessId: input.businessId,
        channel: input.channel,
        toAddress: input.toAddress,
        subject: input.subject,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        kind: input.messageKind,
        state: 'queued',
      }).onConflictDoNothing({
        target: schema.outreachMessages.idempotencyKey,
      }).returning({ id: schema.outreachMessages.id });
      if (inserted) {
        result = { kind: 'reserved', messageId: inserted.id };
        return [];
      }

      const [conflict] = await tx.select({
        id: schema.outreachMessages.id,
        state: schema.outreachMessages.state,
      }).from(schema.outreachMessages)
        .where(eq(schema.outreachMessages.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .for('update');
      if (!conflict) {
        throw new Error(`outreach reservation disappeared for ${input.idempotencyKey}`);
      }
      result = {
        kind: 'duplicate',
        messageId: conflict.id,
        state: conflict.state,
      };
      return [];
    });

    if (!result) throw new Error(`outreach reservation produced no result for ${input.idempotencyKey}`);
    return result;
  }

  async finalizeInitial(input: FinalizeInitialInput): Promise<InitialFinalizationResult> {
    let alreadyFinalizedState: string | null = null;
    let businessAdvanced = false;
    const followupDays = [...this.followupDays()];
    const jobs = await this.commit(async (tx) => {
      const [message] = await tx.select({
        state: schema.outreachMessages.state,
      }).from(schema.outreachMessages)
        .where(and(
          eq(schema.outreachMessages.id, input.messageId),
          eq(schema.outreachMessages.businessId, input.businessId),
        ))
        .limit(1)
        .for('update');
      if (!message) throw new Error(`outreach message ${input.messageId} not found`);
      if (message.state !== 'queued') {
        alreadyFinalizedState = message.state;
        return [];
      }

      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, input.businessId))
        .limit(1)
        .for('update');
      if (!business) throw new Error(`business not found: ${input.businessId}`);
      const businessStatus = requireBusinessStatus(
        business.status,
        `business ${input.businessId}`,
      );
      const sentAt = input.state === 'manual_pending' ? null : new Date();
      await tx.update(schema.outreachMessages).set({
        state: input.state,
        providerMessageId: input.providerMessageId,
        sentAt,
      }).where(eq(schema.outreachMessages.id, input.messageId));
      await tx.insert(schema.outreachEvents).values({
        businessId: input.businessId,
        messageId: input.messageId,
        event: input.state === 'manual_pending' ? 'queued_manual' : 'sent',
        detail: {
          channel: input.channel,
          state: input.state,
          mode: input.mode,
          approvalId: input.approvalId,
        },
      });

      if (input.state === 'manual_pending' || businessStatus !== 'outreach_approved') {
        return [];
      }

      const transition = await this.transitions.normalInTransaction(tx, {
        businessId: input.businessId,
        expectedStatus: 'outreach_approved',
        to: 'contacted',
        actor: 'outreach-worker',
        reason: `${input.channel} ${input.state}`,
      });
      if (transition.kind !== 'moved') {
        throw new Error(`outreach finalization lost its locked transition for ${input.businessId}`);
      }
      await tx.insert(schema.deals).values({
        businessId: input.businessId,
        state: 'contacted',
      }).onConflictDoNothing();
      businessAdvanced = true;
      return createFollowupCommands(
        input.approvalId,
        input.businessId,
        input.channel,
        followupDays,
      );
    });

    if (alreadyFinalizedState !== null) {
      return { kind: 'already_finalized', state: alreadyFinalizedState };
    }
    return { kind: 'finalized', businessAdvanced, followups: jobs };
  }

  async finalizeFollowup(input: FinalizeFollowupInput): Promise<boolean> {
    let finalized = false;
    await this.commit(async (tx) => {
      const [message] = await tx.select({ state: schema.outreachMessages.state })
        .from(schema.outreachMessages)
        .where(and(
          eq(schema.outreachMessages.id, input.messageId),
          eq(schema.outreachMessages.businessId, input.businessId),
        ))
        .limit(1)
        .for('update');
      if (!message) throw new Error(`follow-up message ${input.messageId} not found`);
      if (message.state !== 'queued') return [];

      await tx.update(schema.outreachMessages).set({
        state: input.state,
        providerMessageId: input.providerMessageId,
        sentAt: input.state === 'manual_pending' ? null : new Date(),
      }).where(eq(schema.outreachMessages.id, input.messageId));
      await tx.insert(schema.outreachEvents).values({
        businessId: input.businessId,
        messageId: input.messageId,
        event: input.state === 'manual_pending' ? 'queued_manual' : 'sent',
        detail: {
          kind: `followup_${input.followupIndex}`,
          state: input.state,
          channel: input.channel,
          mode: input.mode,
        },
      });
      finalized = true;
      return [];
    });
    return finalized;
  }

  async markFailed(
    messageId: number,
    businessId: string,
    detail: string,
  ): Promise<void> {
    await this.markTerminal(messageId, businessId, 'failed', detail, false);
  }

  async markDeliveryUnknown(
    messageId: number,
    businessId: string,
    detail: string,
  ): Promise<void> {
    await this.markTerminal(
      messageId,
      businessId,
      'delivery_unknown',
      detail,
      true,
    );
  }

  private async markTerminal(
    messageId: number,
    businessId: string,
    state: 'failed' | 'delivery_unknown',
    detail: string,
    mayHaveSent: boolean,
  ): Promise<void> {
    await this.commit(async (tx) => {
      const changed = await tx.update(schema.outreachMessages).set({
        state,
        sentAt: mayHaveSent ? new Date() : null,
      }).where(and(
        eq(schema.outreachMessages.id, messageId),
        eq(schema.outreachMessages.businessId, businessId),
        eq(schema.outreachMessages.state, 'queued'),
      )).returning({ id: schema.outreachMessages.id });
      if (!changed.length) return [];
      await tx.insert(schema.outreachEvents).values({
        businessId,
        messageId,
        event: state,
        detail: { mayHaveSent, error: detail.slice(0, 1000) },
      });
      return [];
    });
  }
}
