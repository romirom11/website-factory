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
import { db } from '../db/client.js';
import { getBoss } from '../orchestrator/queue.js';
import { InboundOutreachService } from '../orchestrator/inboundOutreachService.js';
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

const inboundService = new InboundOutreachService(db, async (bossJobIds) => {
  if (!bossJobIds.length) return;
  const boss = await getBoss();
  await Promise.all(bossJobIds.map(async (bossJobId) => {
    await boss.cancel('send-followup', bossJobId).catch(() => {
      // It may already have left pg-boss. The logical attempt is cancelled,
      // and the execution-time event/status gates remain authoritative.
    });
  }));
});

/**
 * Cancel the pending follow-up jobs for a business.
 * pg-boss cancellation is best-effort by design here: the follow-up handler
 * re-checks the stop conditions anyway, so a missed cancel is a wasted job,
 * never an unwanted send.
 */
export async function cancelFollowups(businessId: string, reason: string): Promise<number> {
  const cancelled = await inboundService.cancelFollowups(businessId, reason);
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
  idempotencyKey?: string | null;
}): Promise<void> {
  const result = await inboundService.recordOptOut(input);
  if (result.applied) {
    log.info('opt-out recorded', {
      businessId: input.businessId,
      channel: input.channel,
      phrase: input.phrase,
      cancelledFollowups: result.cancelledFollowups,
    });
  }
}

/** A bounce kills the thread but is NOT an opt-out: the business may be reachable elsewhere. */
export async function recordBounce(input: {
  businessId: string;
  messageId: number | null;
  channel: string;
  fromAddress: string;
  reason: string;
  bouncedAddress?: string | null;
  idempotencyKey?: string | null;
}): Promise<void> {
  const result = await inboundService.recordBounce(input);
  if (result.applied) {
    log.info('bounce recorded', {
      businessId: input.businessId,
      reason: input.reason,
      cancelledFollowups: result.cancelledFollowups,
    });
  }
}

/** A real human answered. */
export async function recordReply(
  businessId: string,
  channel: string,
  detail: Record<string, unknown>,
  messageId: number | null = null,
  idempotencyKey: string | null = null,
): Promise<void> {
  const result = await inboundService.recordReply({
    businessId,
    channel,
    detail,
    messageId,
    idempotencyKey,
  });
  if (!result.applied) return;
  await notifyReply({
    businessId,
    name: result.businessName ?? undefined,
    channel,
    preview: String(detail.preview ?? ''),
  }).catch((err) => log.warn('reply notification failed', { businessId, err: String(err) }));
  log.info('reply recorded', {
    businessId,
    channel,
    cancelledFollowups: result.cancelledFollowups,
  });
}

function inboundEventKey(msg: InboundMessage): string | null {
  const providerMessageId = msg.providerMessageId?.trim();
  return providerMessageId ? `inbound:${msg.channel}:${providerMessageId}` : null;
}

/**
 * The single entry point every channel uses. Classification order is fixed:
 * bounce (already detected by the caller) -> opt-out -> plain reply.
 */
export async function processInbound(
  match: ReplyMatch,
  msg: InboundMessage,
): Promise<InboundOutcome> {
  const idempotencyKey = inboundEventKey(msg);
  if (msg.bounceReason) {
    await recordBounce({
      businessId: match.businessId, messageId: match.messageId, channel: msg.channel,
      fromAddress: msg.fromAddress, reason: msg.bounceReason, idempotencyKey,
    });
    return 'bounced';
  }

  const phrase = detectOptOut(msg.text) ?? detectOptOut(msg.subject);
  if (phrase) {
    await recordOptOut({
      businessId: match.businessId, messageId: match.messageId, channel: msg.channel,
      fromAddress: msg.fromAddress, phrase, idempotencyKey,
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
  }, match.messageId, idempotencyKey);
  return 'replied';
}
