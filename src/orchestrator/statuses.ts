import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db, schema } from '../db/client.js';
import { log } from '../lib/logger.js';
import {
  isAllowedBusinessTransition,
  isBusinessStatus,
  type BusinessStatus,
  type BusinessTransitionResult,
} from './businessStatus.js';

export * from './businessStatus.js';

interface TransitionInput {
  businessId: string;
  expectedStatus: BusinessStatus;
  to: BusinessStatus;
  actor: string;
  reason?: string;
}

interface ReasonedTransitionInput extends TransitionInput {
  reason: string;
}

export class BusinessNotFoundError extends Error {
  readonly code = 'BUSINESS_NOT_FOUND';

  constructor(readonly businessId: string) {
    super(`business not found: ${businessId}`);
    this.name = 'BusinessNotFoundError';
  }
}

export class IllegalBusinessTransitionError extends Error {
  readonly code = 'ILLEGAL_BUSINESS_TRANSITION';

  constructor(
    readonly from: BusinessStatus,
    readonly to: BusinessStatus,
    readonly actor: string,
  ) {
    super(`illegal transition ${from} -> ${to} by ${actor}`);
    this.name = 'IllegalBusinessTransitionError';
  }
}

export class TransitionReasonRequiredError extends Error {
  readonly code = 'TRANSITION_REASON_REQUIRED';

  constructor(readonly operation: 'override' | 'recovery') {
    super(`${operation} transition requires a reason`);
    this.name = 'TransitionReasonRequiredError';
  }
}

type TransitionDatabase = NodePgDatabase<typeof schema>;
type TransitionTransaction = Parameters<Parameters<TransitionDatabase['transaction']>[0]>[0];
type TransitionOperation = 'normal' | 'override' | 'recovery';

/**
 * Owns the business state-machine write invariant.
 *
 * A transition may only update the exact state its caller observed. The status
 * row and its audit row commit together, while stale callers return a typed
 * result and never manufacture history for work they did not win.
 */
export class BusinessTransitionService {
  constructor(private readonly database: TransitionDatabase) {}

  async normal(input: TransitionInput): Promise<BusinessTransitionResult> {
    if (!isAllowedBusinessTransition(input.expectedStatus, input.to)) {
      throw new IllegalBusinessTransitionError(
        input.expectedStatus,
        input.to,
        input.actor,
      );
    }
    return this.move('normal', input);
  }

  async override(input: ReasonedTransitionInput): Promise<BusinessTransitionResult> {
    this.requireReason('override', input.reason);
    return this.move('override', input);
  }

  /** Join a larger domain transaction for a forward workflow move. */
  async normalInTransaction(
    transaction: TransitionTransaction,
    input: TransitionInput,
  ): Promise<BusinessTransitionResult> {
    if (!isAllowedBusinessTransition(input.expectedStatus, input.to)) {
      throw new IllegalBusinessTransitionError(
        input.expectedStatus,
        input.to,
        input.actor,
      );
    }
    return this.moveInTransaction(transaction, input);
  }

  /** Join a larger domain transaction for an explicit operator decision. */
  async overrideInTransaction(
    transaction: TransitionTransaction,
    input: ReasonedTransitionInput,
  ): Promise<BusinessTransitionResult> {
    this.requireReason('override', input.reason);
    return this.moveInTransaction(transaction, input);
  }

  async recover(input: ReasonedTransitionInput): Promise<BusinessTransitionResult> {
    this.requireReason('recovery', input.reason);
    return this.move('recovery', input);
  }

  /** Join a larger domain transaction without duplicating status/history SQL. */
  async recoverInTransaction(
    transaction: TransitionTransaction,
    input: ReasonedTransitionInput,
  ): Promise<BusinessTransitionResult> {
    this.requireReason('recovery', input.reason);
    return this.moveInTransaction(transaction, input);
  }

  private requireReason(
    operation: 'override' | 'recovery',
    reason: string,
  ): void {
    if (!reason.trim()) throw new TransitionReasonRequiredError(operation);
  }

  private async move(
    operation: TransitionOperation,
    input: TransitionInput,
  ): Promise<BusinessTransitionResult> {
    const result = await this.database.transaction(
      (tx) => this.moveInTransaction(tx, input),
    );

    if (result.kind === 'moved') {
      log.info('status transition', {
        operation,
        businessId: input.businessId,
        from: result.from,
        to: result.to,
        actor: input.actor,
        reason: input.reason,
      });
    }
    return result;
  }

  private async moveInTransaction(
    tx: TransitionTransaction,
    input: TransitionInput,
  ): Promise<BusinessTransitionResult> {
    if (input.expectedStatus !== input.to) {
      const [changed] = await tx.update(schema.businesses)
        .set({
          status: input.to,
          statusReason: input.reason ?? null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.businesses.id, input.businessId),
          eq(schema.businesses.status, input.expectedStatus),
        ))
        .returning({ id: schema.businesses.id });

      if (changed) {
        await tx.insert(schema.statusHistory).values({
          businessId: input.businessId,
          fromStatus: input.expectedStatus,
          toStatus: input.to,
          reason: input.reason ?? null,
          actor: input.actor,
        });
        return {
          kind: 'moved',
          from: input.expectedStatus,
          to: input.to,
        };
      }
    }

    const [current] = await tx.select({ status: schema.businesses.status })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, input.businessId));
    if (!current) throw new BusinessNotFoundError(input.businessId);
    if (!isBusinessStatus(current.status)) {
      throw new Error(
        `business ${input.businessId} has unknown status: ${current.status}`,
      );
    }
    if (current.status === input.to) {
      return { kind: 'already_at_target', status: current.status };
    }
    return {
      kind: 'conflict',
      expectedStatus: input.expectedStatus,
      currentStatus: current.status,
    };
  }
}

export const businessTransitions = new BusinessTransitionService(db);

/**
 * Shared stale-work policy for worker continuations.
 * Idempotent retries may proceed; a caller that lost CAS must stop before it
 * enqueues the next stage or performs effects based on an obsolete decision.
 */
export function canContinueAfterTransition(
  result: BusinessTransitionResult,
  context: { businessId: string; actor: string },
): boolean {
  if (result.kind !== 'conflict') return true;
  log.warn('stale status transition skipped', {
    ...context,
    expectedStatus: result.expectedStatus,
    currentStatus: result.currentStatus,
  });
  return false;
}
