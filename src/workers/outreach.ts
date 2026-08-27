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
 * `manual_pending`, and Roman's "I sent it" confirmation in the UI flips them
 * to sent and schedules the follow-ups (see confirmManualSend).
 */
import { and, eq, desc, gte, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import {
  businessTransitions,
  canContinueAfterTransition,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { enforceDoNotContact } from '../orchestrator/safetyTransitions.js';
import { enqueue, type JobPayload } from '../orchestrator/queue.js';
import { adapterFor, deepLinkFor, isManualChannel, type OutreachChannel, type OutreachDraft } from '../channels/index.js';
import { notifyManualFollowup } from '../telegram/notify.js';
import { log } from '../lib/logger.js';

/** The one place that derives a send's idempotency key. Approval id => one send. */
export function sendIdempotencyKey(approvalId: number): string {
  return `send-outreach:approval:${approvalId}`;
}

export function followupIdempotencyKey(approvalId: number, index: number): string {
  return `followup:approval:${approvalId}:${index}`;
}

/** States that count as "this message exists, do not create another". */
const LIVE_STATES = ['queued', 'sent', 'delivered', 'simulated', 'manual_pending'];

async function dailySendCount(): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await db.select({ n: sql<number>`count(*)` }).from(schema.outreachMessages)
    .where(and(
      inArray(schema.outreachMessages.state, ['sent', 'simulated']),
      gte(schema.outreachMessages.sentAt, since),
    ));
  return Number(rows[0]?.n ?? 0);
}

/** DNC is checked against the business id and the concrete address being used. */
async function isDoNotContact(businessId: string, toAddress: string): Promise<string | null> {
  const rows = await db.select().from(schema.doNotContact);
  const digits = toAddress.replace(/[^\d]/g, '');
  for (const d of rows) {
    if (d.matchType === 'business_id' && d.value === businessId) return `business_id:${businessId}`;
    if (d.matchType === 'email' && d.value.toLowerCase() === toAddress.toLowerCase()) return `email:${d.value}`;
    if (d.matchType === 'phone' && digits && d.value.replace(/[^\d]/g, '') === digits) return `phone:${d.value}`;
  }
  return null;
}

export async function scheduleFollowups(approvalId: number, businessId: string, channel: string): Promise<void> {
  for (let i = 0; i < config.followupDays.length; i++) {
    const key = followupIdempotencyKey(approvalId, i + 1);
    await enqueue(
      'send-followup',
      { businessId, followupIndex: i + 1, approvalId, channel, idempotencyKey: key },
      { startAfterSeconds: config.followupDays[i] * 24 * 3600 },
    );
  }
  log.info('followups scheduled', { businessId, approvalId, days: config.followupDays });
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

  const [business] = await db.select({ status: schema.businesses.status })
    .from(schema.businesses)
    .where(eq(schema.businesses.id, businessId));
  if (!business) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(business.status, `business ${businessId}`);
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

  // ── Gate 3: exactly once. The unique index on idempotency_key is the referee:
  // a concurrent duplicate loses the insert race and returns no row.
  const [msg] = await db.insert(schema.outreachMessages).values({
    businessId,
    channel: draft.channel,
    toAddress: draft.toAddress,
    subject: draft.subject,
    body: draft.body,
    idempotencyKey: expectedKey,
    kind: 'initial',
    state: 'queued',
  }).onConflictDoNothing({ target: schema.outreachMessages.idempotencyKey }).returning();

  if (!msg) {
    log.warn('outreach already exists for this approval, refusing duplicate send', {
      businessId, approvalId: approval.id, idempotencyKey: expectedKey,
    });
    return;
  }

  // ── Gate 4: daily limit, checked at send time. The row is rolled back so the
  // send can legitimately happen tomorrow under the same key.
  if ((await dailySendCount()) >= config.outreachDailyLimit) {
    await db.delete(schema.outreachMessages).where(eq(schema.outreachMessages.id, msg.id));
    throw new Error(`daily outreach limit (${config.outreachDailyLimit}) reached; re-enqueue this send tomorrow`);
  }

  const adapter = adapterFor(draft.channel);
  const manual = isManualChannel(draft.channel);
  let state: string;
  let providerMessageId: string | null = null;

  try {
    if (manual) {
      // Instagram/Viber: the factory never sends. The UI shows a deep link and
      // waits for Roman's confirmation (confirmManualSend).
      state = 'manual_pending';
      log.info('manual channel: waiting for Roman to send from the UI', {
        businessId, channel: draft.channel, approvalId: approval.id,
      });
    } else if (config.mode === 'dry_run') {
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
    await db.update(schema.outreachMessages).set({ state: 'failed' })
      .where(eq(schema.outreachMessages.id, msg.id));
    throw err; // never auto-retried (RETRY limit 0 for send-outreach)
  }

  await db.update(schema.outreachMessages)
    .set({ state, providerMessageId, sentAt: state === 'manual_pending' ? null : new Date() })
    .where(eq(schema.outreachMessages.id, msg.id));
  await db.insert(schema.outreachEvents).values({
    businessId, messageId: msg.id,
    event: state === 'manual_pending' ? 'queued_manual' : 'sent',
    detail: { channel: draft.channel, state, mode: config.mode, approvalId: approval.id },
  });

  // Manual channels only become `contacted` once Roman confirms he sent it.
  if (state !== 'manual_pending') {
    const transitioned = await businessTransitions.normal({
      businessId,
      expectedStatus: 'outreach_approved',
      to: 'contacted',
      actor: 'outreach-worker',
      reason: `${draft.channel} ${state}`,
    });
    if (!canContinueAfterTransition(transitioned, { businessId, actor: 'outreach-worker' })) return;
    await db.insert(schema.deals).values({ businessId, state: 'contacted' }).onConflictDoNothing();
    await scheduleFollowups(approval.id, businessId, draft.channel);
  }

  log.info('outreach done', { businessId, channel: draft.channel, state, approvalId: approval.id });
}

/**
 * Roman tapped "I sent it" for a manual channel in the UI.
 * Flips the pending message to sent, moves the business to contacted and
 * schedules the follow-ups. Idempotent: a second confirmation is a no-op.
 */
export async function confirmManualSend(businessId: string, approvalId: number): Promise<'confirmed' | 'already'> {
  const key = sendIdempotencyKey(approvalId);
  const [msg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.idempotencyKey, key));
  if (!msg) throw new Error(`no outreach message for approval #${approvalId}`);
  if (msg.state !== 'manual_pending') return 'already';

  const [business] = await db.select({ status: schema.businesses.status })
    .from(schema.businesses)
    .where(eq(schema.businesses.id, businessId));
  if (!business) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(business.status, `business ${businessId}`);
  if (expectedStatus !== 'outreach_approved' && expectedStatus !== 'contacted') {
    log.info('manual send confirmation skipped: business already changed state', {
      businessId,
      approvalId,
      status: expectedStatus,
    });
    return 'already';
  }

  await db.update(schema.outreachMessages)
    .set({ state: 'sent', sentAt: new Date() })
    .where(eq(schema.outreachMessages.id, msg.id));
  await db.insert(schema.outreachEvents).values({
    businessId, messageId: msg.id, event: 'sent',
    detail: { channel: msg.channel, manualConfirmation: true, actor: 'roman' },
  });
  const transitioned = await businessTransitions.normal({
    businessId,
    expectedStatus,
    to: 'contacted',
    actor: 'roman',
    reason: `${msg.channel} sent manually`,
  });
  if (!canContinueAfterTransition(transitioned, { businessId, actor: 'roman' })) return 'already';
  await db.insert(schema.deals).values({ businessId, state: 'contacted' }).onConflictDoNothing();
  await scheduleFollowups(approvalId, businessId, msg.channel);
  log.info('manual send confirmed', { businessId, approvalId, channel: msg.channel });
  return 'confirmed';
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

  const [msg] = await db.insert(schema.outreachMessages).values({
    businessId,
    channel: initial.channel,
    toAddress: initial.toAddress,
    subject: initial.subject ? `Re: ${initial.subject}` : null,
    body,
    idempotencyKey: key,
    kind: `followup_${idx}`,
    state: 'queued',
  }).onConflictDoNothing({ target: schema.outreachMessages.idempotencyKey }).returning();
  if (!msg) { log.warn('followup already exists', { businessId, key }); return; }

  // Follow-ups count against the same daily budget as first contact.
  if ((await dailySendCount()) >= config.outreachDailyLimit) {
    await db.delete(schema.outreachMessages).where(eq(schema.outreachMessages.id, msg.id));
    log.warn('followup postponed: daily limit reached', { businessId, idx });
    throw new Error(`daily outreach limit (${config.outreachDailyLimit}) reached; follow-up ${idx} not sent`);
  }

  const channel = initial.channel as OutreachChannel;
  const adapter = adapterFor(channel);
  const draft: OutreachDraft = {
    channel, toAddress: initial.toAddress, subject: initial.subject, body,
  };
  let state: string;
  let providerMessageId: string | null = null;
  try {
    if (isManualChannel(channel)) {
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
    } else if (config.mode === 'dry_run') {
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
    await db.update(schema.outreachMessages).set({ state: 'failed' }).where(eq(schema.outreachMessages.id, msg.id));
    throw err; // never auto-retried
  }

  await db.update(schema.outreachMessages)
    .set({ state, providerMessageId, sentAt: state === 'manual_pending' ? null : new Date() })
    .where(eq(schema.outreachMessages.id, msg.id));
  await db.insert(schema.outreachEvents).values({
    businessId, messageId: msg.id, event: state === 'manual_pending' ? 'queued_manual' : 'sent',
    detail: { kind: `followup_${idx}`, state, channel },
  });
  log.info('followup processed', { businessId, idx, state });
}

export { LIVE_STATES };
