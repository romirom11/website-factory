/**
 * Stage 14 — send-outreach (SPEC §4, §7, decision #8).
 *
 * Hard invariants enforced here, in code, not in the UI:
 *  1. A send requires an `approvals` row with decision='approved' for THIS
 *     business, and the job must carry that approval's idempotency key.
 *     No approval row => no send is technically possible.
 *  2. Exactly one message per idempotency key. The key is derived from the
 *     approval id, and `outreach_messages.idempotency_key` is UNIQUE, so a
 *     double click, a double enqueue and a concurrent worker all collapse
 *     into one row — the DB is the referee, not an if-statement.
 *  3. do_not_contact and the daily limit are re-checked AT SEND TIME, not at
 *     approval time.
 *  4. Sends are NEVER auto-retried (queue.ts RETRY limit 0).
 *
 * Manual channels (instagram/viber) never send from here: they land as
 * `manual_pending`, and Roman's "I sent it" command is committed by
 * `OutreachDecisionService` together with status, audit and follow-up jobs.
 */
import { and, eq, desc, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { requireBusinessStatus } from '../orchestrator/statuses.js';
import { enforceDoNotContact } from '../orchestrator/safetyTransitions.js';
import { commitWorkflow, type JobPayload } from '../orchestrator/queue.js';
import {
  adapterFor,
  deepLinkFor,
  isManualChannel,
  NotConfiguredError,
  type OutreachChannel,
  type OutreachDraft,
} from '../channels/index.js';
import { notifyManualFollowup } from '../telegram/notify.js';
import { log } from '../lib/logger.js';
import { OutreachDeliveryService } from '../orchestrator/outreachDeliveryService.js';
import {
  followupIdempotencyKey,
  sendIdempotencyKey,
} from '../outreach/idempotency.js';
import { normalizeDoNotContactValue } from '../outreach/doNotContact.js';

export { followupIdempotencyKey, sendIdempotencyKey } from '../outreach/idempotency.js';

const outreachDelivery = new OutreachDeliveryService(
  commitWorkflow,
  db,
  () => config.followupDays,
);

/** Live delivery is a two-key switch: global factory AND campaign must opt in. */
export function resolveOutreachMode(
  factoryMode: string,
  campaignMode: string | null | undefined,
): 'dry_run' | 'live' {
  return factoryMode === 'live' && campaignMode === 'live' ? 'live' : 'dry_run';
}

async function outreachModeForBusiness(businessId: string): Promise<'dry_run' | 'live'> {
  const [row] = await db.select({ campaignMode: schema.campaigns.mode })
    .from(schema.businesses)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.businesses.campaignId))
    .where(eq(schema.businesses.id, businessId));
  if (!row) throw new Error(`business or campaign not found: ${businessId}`);
  return resolveOutreachMode(config.mode, row.campaignMode);
}

/** DNC is checked against the business id and the concrete address being used. */
async function isDoNotContact(businessId: string, toAddress: string): Promise<string | null> {
  const email = normalizeDoNotContactValue('email', toAddress);
  const phone = normalizeDoNotContactValue('phone', toAddress);
  const [match] = await db.select({
    matchType: schema.doNotContact.matchType,
    value: schema.doNotContact.value,
  }).from(schema.doNotContact)
    .where(or(
      and(
        eq(schema.doNotContact.matchType, 'business_id'),
        eq(schema.doNotContact.value, businessId),
      ),
      and(
        eq(schema.doNotContact.matchType, 'email'),
        sql`lower(trim(${schema.doNotContact.value})) = ${email}`,
      ),
      and(
        eq(schema.doNotContact.matchType, 'phone'),
        sql`${phone} <> ''`,
        sql`regexp_replace(${schema.doNotContact.value}, '[^0-9]', '', 'g') = ${phone}`,
      ),
    ))
    .limit(1);
  return match ? `${match.matchType}:${match.value}` : null;
}

function errorDetail(error: unknown): string {
  return String(error instanceof Error ? error.stack ?? error.message : error);
}

async function markDeliveryFailure(
  messageId: number,
  businessId: string,
  error: unknown,
  mayHaveSent: boolean,
): Promise<void> {
  const detail = errorDetail(error);
  try {
    if (mayHaveSent) {
      await outreachDelivery.markDeliveryUnknown(messageId, businessId, detail);
    } else {
      await outreachDelivery.markFailed(messageId, businessId, detail);
    }
  } catch (recordError) {
    log.error('failed to persist outreach delivery failure', {
      businessId,
      messageId,
      mayHaveSent,
      err: errorDetail(recordError),
    });
  }
}

export async function sendOutreachHandler(job: JobPayload): Promise<void> {
  const businessId = job.businessId!;

  // ── Gate 1: an approved approval must exist.
  const [approval] = await db.select().from(schema.approvals)
    .where(and(
      eq(schema.approvals.businessId, businessId),
      eq(schema.approvals.kind, 'outreach'),
      eq(schema.approvals.decision, 'approved'),
    ))
    .orderBy(desc(schema.approvals.decidedAt)).limit(1);
  if (!approval) throw new Error(`no recorded approval for ${businessId}; refusing to send`);

  const [business] = await db.select({
    status: schema.businesses.status,
    campaignMode: schema.campaigns.mode,
  })
    .from(schema.businesses)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.businesses.campaignId))
    .where(eq(schema.businesses.id, businessId));
  if (!business) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(business.status, `business ${businessId}`);
  const outreachMode = resolveOutreachMode(config.mode, business.campaignMode);
  if (expectedStatus !== 'outreach_approved') {
    log.info('outreach skipped: approval is stale for current business status', {
      businessId,
      status: expectedStatus,
      approvalId: approval.id,
    });
    return;
  }

  const expectedKey = sendIdempotencyKey(approval.id);
  if (job.idempotencyKey && job.idempotencyKey !== expectedKey) {
    throw new Error(
      `idempotency key mismatch for ${businessId}: job=${job.idempotencyKey} approval=${expectedKey}`,
    );
  }

  const payload = approval.payload as any;
  const draftRaw = payload?.draft;
  if (!draftRaw?.channel || !draftRaw?.toAddress) {
    throw new Error(`approval #${approval.id} has no channel/address; refusing to send`);
  }
  const draft: OutreachDraft = {
    channel: draftRaw.channel as OutreachChannel,
    toAddress: String(draftRaw.toAddress),
    subject: draftRaw.subject ?? null,
    body: String(draftRaw.body ?? ''),
  };

  // ── Gate 2: do_not_contact, re-checked now.
  const dnc = await isDoNotContact(businessId, draft.toAddress);
  if (dnc) {
    log.warn('send blocked by do_not_contact', { businessId, dnc });
    await enforceDoNotContact(
      businessId,
      'outreach-worker',
      `dnc match at send time (${dnc})`,
    );
    return;
  }

  const manual = isManualChannel(draft.channel);

  // ── Gates 3 + 4: exactly-once intent and the daily budget are reserved in
  // one serialized transaction. Parallel workers cannot overshoot the limit.
  const reservation = await outreachDelivery.reserveMessage({
    businessId,
    channel: draft.channel,
    toAddress: draft.toAddress,
    subject: draft.subject,
    body: draft.body,
    idempotencyKey: expectedKey,
    messageKind: 'initial',
    dailyLimit: config.outreachDailyLimit,
  });
  if (reservation.kind === 'daily_limit') {
    throw new Error(
      `daily outreach limit (${reservation.limit}) reached; re-enqueue this send tomorrow`,
    );
  }
  if (reservation.kind === 'duplicate') {
    log.warn('outreach already exists for this approval, refusing duplicate send', {
      businessId,
      approvalId: approval.id,
      idempotencyKey: expectedKey,
      state: reservation.state,
    });
    return;
  }
  const messageId = reservation.messageId;

  const adapter = adapterFor(draft.channel);
  let state: 'sent' | 'simulated' | 'manual_pending';
  let providerMessageId: string | null = null;

  try {
    if (manual) {
      // Instagram/Viber: the factory never sends. The UI shows a deep link and
      // waits for Roman's confirmation (confirmManualSend).
      state = 'manual_pending';
      log.info('manual channel: waiting for Roman to send from the UI', {
        businessId, channel: draft.channel, approvalId: approval.id,
      });
    } else if (outreachMode === 'dry_run') {
      const res = await adapter.sendDryRun(draft, { idempotencyKey: expectedKey });
      state = res.state;
      providerMessageId = res.providerMessageId;
    } else {
      // Live send. The idempotency key travels into the transport: email turns
      // it into our own Message-ID, which is what reply matching keys off.
      const res = await adapter.sendLive(draft, { idempotencyKey: expectedKey });
      state = res.state;
      providerMessageId = res.providerMessageId;
    }
  } catch (err) {
    const mayHaveSent = outreachMode === 'live'
      && !manual
      && !(err instanceof NotConfiguredError);
    await markDeliveryFailure(messageId, businessId, err, mayHaveSent);
    throw err; // never auto-retried (RETRY limit 0 for send-outreach)
  }

  let finalized;
  try {
    finalized = await outreachDelivery.finalizeInitial({
      messageId,
      businessId,
      approvalId: approval.id,
      channel: draft.channel,
      state,
      providerMessageId,
      mode: outreachMode,
    });
  } catch (err) {
    await markDeliveryFailure(
      messageId,
      businessId,
      err,
      outreachMode === 'live' && !manual,
    );
    throw err;
  }
  if (finalized.kind === 'finalized' && !finalized.businessAdvanced && !manual) {
    log.warn('outreach delivered after business status advanced; followups suppressed', {
      businessId,
      approvalId: approval.id,
    });
  }
  if (finalized.kind === 'finalized' && finalized.followups.length) {
    log.info('followups scheduled', {
      businessId,
      approvalId: approval.id,
      days: config.followupDays,
    });
  }

  log.info('outreach done', { businessId, channel: draft.channel, state, approvalId: approval.id });
}

/** Statuses past `contacted`: the business has moved on, a nudge would be noise. */
const BEYOND_CONTACTED = new Set([
  'replied', 'meeting', 'proposal', 'won', 'lost', 'closed', 'do_not_contact', 'rejected',
]);

export type FollowupSkipReason =
  | 'deal_advanced' | 'reply_optout_bounce' | 'status_beyond_contacted'
  | 'initial_not_sent' | 'do_not_contact' | 'duplicate' | 'daily_limit';

/**
 * Every reason a scheduled follow-up must NOT go out (SPEC §4 stage 15).
 * Evaluated at EXECUTION time, not at scheduling time: a reply that arrived
 * three days after approval has to stop the nudge, and the pg-boss cancel in
 * `cancelFollowups` is best-effort, so this is the real gate.
 */
export async function followupSkipReason(
  businessId: string,
  initialState: string | undefined,
  toAddress: string | undefined,
): Promise<FollowupSkipReason | null> {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (biz && BEYOND_CONTACTED.has(biz.status)) return 'status_beyond_contacted';

  const [deal] = await db.select().from(schema.deals).where(eq(schema.deals.businessId, businessId));
  if (deal && deal.state !== 'contacted') return 'deal_advanced';

  const events = await db.select().from(schema.outreachEvents)
    .where(eq(schema.outreachEvents.businessId, businessId));
  if (events.some((e) => ['replied', 'opted_out', 'bounced'].includes(e.event))) return 'reply_optout_bounce';

  if (!initialState || !['sent', 'simulated'].includes(initialState)) return 'initial_not_sent';
  if (toAddress && (await isDoNotContact(businessId, toAddress))) return 'do_not_contact';
  return null;
}

const FOLLOWUP_BODIES = [
  'Просто нагадаю про демо, яке я зробив для вас 🙂 Якщо цікаво, гляньте, коли буде хвилинка.',
  'Останнє нагадування: демо ще активне. Якщо неактуально, просто проігноруйте це повідомлення, більше не потурбую.',
];

export async function sendFollowupHandler(job: JobPayload): Promise<void> {
  const businessId = job.businessId!;
  const idx = job.followupIndex as number;
  const approvalId = job.approvalId as number | undefined;
  const outreachMode = await outreachModeForBusiness(businessId);

  const [initial] = await db.select().from(schema.outreachMessages)
    .where(and(eq(schema.outreachMessages.businessId, businessId), eq(schema.outreachMessages.kind, 'initial')))
    .orderBy(desc(schema.outreachMessages.id)).limit(1);

  const skip = await followupSkipReason(businessId, initial?.state, initial?.toAddress);
  if (skip) {
    log.info('followup skipped', { businessId, idx, reason: skip, state: initial?.state });
    return;
  }

  const body = FOLLOWUP_BODIES[Math.min(idx, FOLLOWUP_BODIES.length) - 1] ?? FOLLOWUP_BODIES[FOLLOWUP_BODIES.length - 1];
  const key = approvalId
    ? followupIdempotencyKey(approvalId, idx)
    : `followup:${businessId}:${initial.channel}:${idx}`;

  const channel = initial.channel as OutreachChannel;
  const manual = isManualChannel(channel);
  const reservation = await outreachDelivery.reserveMessage({
    businessId,
    channel,
    toAddress: initial.toAddress,
    subject: initial.subject ? `Re: ${initial.subject}` : null,
    body,
    idempotencyKey: key,
    messageKind: `followup_${idx}`,
    dailyLimit: config.outreachDailyLimit,
  });
  if (reservation.kind === 'daily_limit') {
    log.warn('followup postponed: daily limit reached', { businessId, idx });
    throw new Error(
      `daily outreach limit (${reservation.limit}) reached; follow-up ${idx} not sent`,
    );
  }
  if (reservation.kind === 'duplicate') {
    log.warn('followup already exists', { businessId, key, state: reservation.state });
    return;
  }
  const messageId = reservation.messageId;

  const adapter = adapterFor(channel);
  const draft: OutreachDraft = {
    channel, toAddress: initial.toAddress, subject: initial.subject, body,
  };
  let state: 'sent' | 'simulated' | 'manual_pending';
  let providerMessageId: string | null = null;
  try {
    if (manual) {
      // Instagram/Viber: a follow-up is a Telegram card with a deep link, never
      // an automatic send (SPEC §2.2 — DM automation risks the account).
      state = 'manual_pending';
      await notifyManualFollowup({
        businessId,
        channel,
        index: idx,
        deepLink: deepLinkFor(draft),
        body,
      }).catch((err) => log.warn('manual followup notification failed', { businessId, err: String(err) }));
    } else if (outreachMode === 'dry_run') {
      const res = await adapter.sendDryRun(draft, { idempotencyKey: key });
      state = res.state;
      providerMessageId = res.providerMessageId;
    } else {
      // Thread the follow-up under the first message so it lands in the same
      // conversation rather than looking like a fresh cold email.
      const res = await adapter.sendLive(draft, {
        idempotencyKey: key,
        inReplyTo: initial.providerMessageId ?? undefined,
      });
      state = res.state;
      providerMessageId = res.providerMessageId;
    }
  } catch (err) {
    const mayHaveSent = outreachMode === 'live'
      && !manual
      && !(err instanceof NotConfiguredError);
    await markDeliveryFailure(messageId, businessId, err, mayHaveSent);
    throw err; // never auto-retried
  }

  try {
    await outreachDelivery.finalizeFollowup({
      messageId,
      businessId,
      followupIndex: idx,
      channel,
      state,
      providerMessageId,
      mode: outreachMode,
    });
  } catch (err) {
    await markDeliveryFailure(
      messageId,
      businessId,
      err,
      outreachMode === 'live' && !manual,
    );
    throw err;
  }
  log.info('followup processed', { businessId, idx, state });
}
