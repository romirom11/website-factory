/**
 * What happens to an inbound message once it has been matched to a business
 * (SPEC §4 stage 15, §8). One implementation for every channel: the IMAP
 * poller and the WAHA webhook both land here, so an opt-out over WhatsApp and
 * an opt-out over email are treated identically.
 *
 * Three outcomes, in precedence order:
 *   opt-out  -> do_not_contact FOREVER (§8), follow-ups stop, no Telegram fanfare
 *   bounce   -> outreach_events bounce, follow-ups stop, address recorded
 *   reply    -> deal replied, business replied, Telegram ping with a UI link
 *
 * "Follow-ups stop" is enforced twice on purpose: this module cancels the
 * scheduled pg-boss jobs, AND sendFollowupHandler re-checks the same conditions
 * at execution time. A cancel that silently fails must not turn into a send.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { businessTransitions, requireBusinessStatus } from '../orchestrator/statuses.js';
import { enforceDoNotContact } from '../orchestrator/safetyTransitions.js';
import { getBoss } from '../orchestrator/queue.js';
import { notifyReply } from '../telegram/notify.js';
import { log } from '../lib/logger.js';
import { detectOptOut } from './optout.js';
import type { ReplyMatch } from './replyMatch.js';

export type InboundOutcome = 'replied' | 'opted_out' | 'bounced' | 'ignored';

export interface InboundMessage {
  channel: string;
  /** Sender address: email or phone digits. */
  fromAddress: string;
  subject?: string | null;
  text?: string | null;
  /** Provider's own id, for the audit trail and dedup. */
  providerMessageId?: string | null;
  /** Already-classified bounce reason, when the caller detected one. */
  bounceReason?: string | null;
}

/**
 * Cancel the pending follow-up jobs for a business.
 * pg-boss cancellation is best-effort by design here: the follow-up handler
 * re-checks the stop conditions anyway, so a missed cancel is a wasted job,
 * never an unwanted send.
 */
export async function cancelFollowups(businessId: string, reason: string): Promise<number> {
  let cancelled = 0;
  try {
    const boss = await getBoss();
    // pg-boss keeps its own tables; the factory's mirror is workflow_jobs.
    const rows = await db.select().from(schema.workflowJobs)
      .where(and(
        eq(schema.workflowJobs.jobType, 'send-followup'),
        eq(schema.workflowJobs.businessId, businessId),
      ));
    for (const row of rows) {
      if (!row.bossJobId || !['queued', 'retry_wait'].includes(row.status)) continue;
      await boss.cancel('send-followup', row.bossJobId).catch(() => { /* already gone */ });
      await db.update(schema.workflowJobs)
        .set({ status: 'cancelled', errorDetail: `cancelled: ${reason}`, finishedAt: new Date() })
        .where(eq(schema.workflowJobs.id, row.id));
      cancelled++;
    }
  } catch (err) {
    log.warn('follow-up cancellation failed; the handler will still skip them', {
      businessId, err: String(err),
    });
  }
  if (cancelled) log.info('follow-ups cancelled', { businessId, cancelled, reason });
  return cancelled;
}

/** Opt-out is permanent (SPEC §8) and applies to the address AND the business. */
export async function recordOptOut(input: {
  businessId: string;
  messageId: number | null;
  channel: string;
  fromAddress: string;
  phrase: string;
}): Promise<void> {
  const matchType = input.channel === 'email' ? 'email' : 'phone';
  const value = input.channel === 'email'
    ? input.fromAddress.trim().toLowerCase()
    : input.fromAddress.replace(/[^\d]/g, '');

  if (value) {
    await db.insert(schema.doNotContact)
      .values({ matchType, value, reason: `opt-out via ${input.channel}: "${input.phrase}"` })
      .onConflictDoNothing();
  }
  // The business itself is blocked too: a second address must not reopen it.
  await db.insert(schema.doNotContact)
    .values({
      matchType: 'business_id', value: input.businessId,
      reason: `opt-out via ${input.channel}: "${input.phrase}"`,
    })
    .onConflictDoNothing();

  await db.insert(schema.outreachEvents).values({
    businessId: input.businessId, messageId: input.messageId, event: 'opted_out',
    detail: { channel: input.channel, phrase: input.phrase, from: input.fromAddress },
  });
  await cancelFollowups(input.businessId, 'opt-out');
  await enforceDoNotContact(
    input.businessId,
    'replies-worker',
    `opt-out via ${input.channel}`,
  );
  log.info('opt-out recorded', { businessId: input.businessId, channel: input.channel, phrase: input.phrase });
}

/** A bounce kills the thread but is NOT an opt-out: the business may be reachable elsewhere. */
export async function recordBounce(input: {
  businessId: string;
  messageId: number | null;
  channel: string;
  fromAddress: string;
  reason: string;
  bouncedAddress?: string | null;
}): Promise<void> {
  await db.insert(schema.outreachEvents).values({
    businessId: input.businessId, messageId: input.messageId, event: 'bounced',
    detail: {
      channel: input.channel, reason: input.reason,
      bouncedAddress: input.bouncedAddress ?? null, from: input.fromAddress,
    },
  });
  if (input.messageId) {
    await db.update(schema.outreachMessages).set({ state: 'failed' })
      .where(eq(schema.outreachMessages.id, input.messageId));
  }
  await cancelFollowups(input.businessId, 'bounce');
  log.info('bounce recorded', { businessId: input.businessId, reason: input.reason });
}

/** A real human answered. */
export async function recordReply(
  businessId: string,
  channel: string,
  detail: Record<string, unknown>,
  messageId: number | null = null,
): Promise<void> {
  await db.insert(schema.outreachEvents).values({
    businessId, messageId, event: 'replied', detail,
  });
  await cancelFollowups(businessId, 'reply');
  const finalStatus = await recordReplyStatus(businessId, channel);
  if (finalStatus === 'replied') {
    // The deal row may not exist for a manual channel confirmed out of band.
    await db.insert(schema.deals).values({ businessId, state: 'replied' })
      .onConflictDoUpdate({
        target: schema.deals.businessId,
        set: { state: 'replied', updatedAt: new Date() },
      });
  }

  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  await notifyReply({
    businessId, name: biz?.name, channel, preview: String(detail.preview ?? ''),
  }).catch((err) => log.warn('reply notification failed', { businessId, err: String(err) }));
  log.info('reply recorded', { businessId, channel });
}

const REPLY_STATES_TO_PRESERVE = new Set([
  'meeting', 'proposal', 'won', 'lost', 'closed', 'do_not_contact',
]);

/** Apply a real inbound reply without regressing a deal that already advanced. */
async function recordReplyStatus(businessId: string, channel: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [business] = await db.select({ status: schema.businesses.status })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId));
    if (!business) throw new Error(`business not found: ${businessId}`);
    const expectedStatus = requireBusinessStatus(business.status, `business ${businessId}`);
    if (expectedStatus === 'replied' || REPLY_STATES_TO_PRESERVE.has(expectedStatus)) {
      return expectedStatus;
    }

    const reason = `reply via ${channel}`;
    const result = expectedStatus === 'contacted'
      ? await businessTransitions.normal({
          businessId, expectedStatus, to: 'replied', actor: 'replies-worker', reason,
        })
      : await businessTransitions.override({
          businessId, expectedStatus, to: 'replied', actor: 'replies-worker',
          reason: `${reason}; reply arrived outside the expected contacted state`,
        });
    if (result.kind !== 'conflict') return 'replied' as const;
  }
  throw new Error(`could not record reply after repeated concurrent transitions: ${businessId}`);
}

/**
 * The single entry point every channel uses. Classification order is fixed:
 * bounce (already detected by the caller) -> opt-out -> plain reply.
 */
export async function processInbound(
  match: ReplyMatch,
  msg: InboundMessage,
): Promise<InboundOutcome> {
  if (msg.bounceReason) {
    await recordBounce({
      businessId: match.businessId, messageId: match.messageId, channel: msg.channel,
      fromAddress: msg.fromAddress, reason: msg.bounceReason,
    });
    return 'bounced';
  }

  const phrase = detectOptOut(msg.text) ?? detectOptOut(msg.subject);
  if (phrase) {
    await recordOptOut({
      businessId: match.businessId, messageId: match.messageId, channel: msg.channel,
      fromAddress: msg.fromAddress, phrase,
    });
    return 'opted_out';
  }

  await recordReply(match.businessId, msg.channel, {
    preview: (msg.text ?? '').slice(0, 500),
    subject: msg.subject ?? null,
    from: msg.fromAddress,
    providerMessageId: msg.providerMessageId ?? null,
    matchedVia: match.via,
    matchDetail: match.detail,
  }, match.messageId);
  return 'replied';
}
