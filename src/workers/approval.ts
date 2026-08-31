/**
 * Stage 13 — request-approval (SPEC §4).
 *
 * Prepares everything Roman needs to decide, writes a PENDING `approvals` row,
 * and pings Telegram with a link into the UI's approval queue. It NEVER
 * decides anything: `decision` stays null until Roman clicks in the UI.
 *
 * Channel is picked by deterministic code (src/channels/select.ts, decision #8),
 * not by the model — the agent only writes the message text. Roman can override
 * both the channel and the text in the UI before approving.
 */
import { eq, desc, and, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { runAgent, z } from '../agents/agent.js';
import { isRateLimitedError } from '../agents/types.js';
import { buildClientSnapshot } from './snapshot.js';
import { selectChannel, type ChannelSelection } from '../channels/select.js';
import { notifyDemoReady } from '../telegram/notify.js';
import type { JobPayload } from '../orchestrator/queue.js';
import { log } from '../lib/logger.js';

/** Shape the drafting agent must return. Channel is NOT part of it — code owns that. */
const DraftSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  reasoning: z.string(),
});

type DraftShape = { subject: string | null; body: string; reasoning: string };

/**
 * The fallback draft, used only when `outreach-writer` cannot produce one.
 *
 * Deliberately plain and deliberately NOT personalised: a template that guessed
 * at the business ("we loved your balayage work") would be exactly the invented
 * fact the whole evidence pipeline exists to prevent. It states two things the
 * factory knows for certain — the business's own name and the demo built for
 * it — and leaves the personal observation for Roman to add. It is marked
 * `needsEdit` so the card says so out loud rather than letting a template go
 * out looking like written copy.
 */
function templateDraft(name: string, demoUrl: string | null, channel: string | null): DraftShape {
  const link = demoUrl ?? '[посилання на демо]';
  const body = channel === 'email'
    ? `Hello ${name},\n\nI'm Roman, a web developer. I built a free demo website for `
      + `${name} — you can see it here: ${link}\n\nNo strings attached: take a look and `
      + `tell me what you think.\n\nRoman`
    : `Hello ${name}! I'm Roman, a web developer. I built you a free demo website: `
      + `${link} — take a look and tell me what you think.`;
  return {
    subject: channel === 'email' ? `A free demo website for ${name}` : null,
    reasoning: 'template fallback: outreach-writer produced no draft',
    body,
  };
}

/** What the UI reads out of `approvals.payload` for a pending row. */
export interface ApprovalPayload {
  draft: { channel: string | null; toAddress: string | null; subject: string | null; body: string };
  channelReason: string;
  manualChannel: boolean;
  candidates: ChannelSelection['candidates'];
  demoUrl: string | null;
  score: number | null;
  websiteVerdict: string;
  /** Why this business is in the queue at all — shown above the preview. */
  queueReason: string;
  /**
   * True when `body` is the fallback TEMPLATE, not agent-written copy: the
   * drafting agent failed and the card must tell Roman to rewrite the text
   * before approving. The send itself is unaffected — this is a quality flag
   * on the draft, never a gate; the gate is still and only his approval.
   */
  needsEdit?: boolean;
  /** Why the draft needs editing, in Ukrainian, for the card. */
  needsEditReason?: string | null;
}

export async function prepareApproval(businessId: string) {
  const snapshot = await buildClientSnapshot(businessId);
  const selection = await selectChannel(businessId);
  const [project] = await db.select().from(schema.siteProjects)
    .where(eq(schema.siteProjects.businessId, businessId))
    .orderBy(desc(schema.siteProjects.createdAt)).limit(1);
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));

  let draft: DraftShape;
  let draftFailure: string | null = null;
  try {
    draft = await runAgent(
      'outreach-writer',
      `You write a short, personal first outreach message from Roman, a web developer, to a local business owner.
Language: the business's language (${snapshot.language}). Tone: warm, specific, zero spam clichés.
Structure: 1) one specific genuine observation about THEIR business (from snapshot facts),
2) that you built them a free personalized demo website, link included, 3) soft CTA (reply / take a look).
Max 120 words for email, max 80 for whatsapp/instagram/viber. Never invent facts.
Channel already chosen by the factory: ${selection.channel ?? 'none'} to ${selection.toAddress ?? '-'}.
Demo URL: ${project?.deployUrl ?? 'MISSING'}.`,
      JSON.stringify({ snapshot, channel: selection.channel, toAddress: selection.toAddress }, null, 2),
      DraftSchema,
    );
  } catch (err) {
    // A COPYWRITING failure must not cost Roman the decision.
    //
    // This is what the 2026-08-20 audit found (P0-1): the one finished demo the
    // factory ever produced could never be approved, because `outreach-writer`
    // threw and the whole handler died before writing the `approvals` row. No
    // row, no inbox card, no way to send — and the big green
    // «Підтвердити відправку →» on the card led to «нічого не чекає».
    //
    // Everything that actually GATES a send is deterministic and already in
    // hand at this point: the channel and address (`src/channels/select.ts`),
    // the demo URL, the snapshot. The only missing piece is prose, which Roman
    // can write faster than a retry loop can. So the row is written with a
    // template body and `needsEdit`, and the card asks him to edit before
    // approving.
    //
    // The invariant is untouched: no fact is invented (the template states only
    // the business's own name and its own demo link), and the send still
    // requires his recorded approval.
    if (isRateLimitedError(err)) throw err; // the window will reopen; do not template over it
    draftFailure = String((err as Error)?.message ?? err).slice(0, 300);
    log.warn('outreach-writer failed; falling back to an editable template', {
      businessId, err: draftFailure,
    });
    draft = templateDraft(snapshot.name, project?.deployUrl ?? null, selection.channel);
  }

  const payload: ApprovalPayload = {
    draft: {
      channel: selection.channel,
      toAddress: selection.toAddress,
      subject: draft.subject,
      body: draft.body,
    },
    channelReason: selection.reason,
    manualChannel: selection.manual,
    candidates: selection.candidates,
    demoUrl: project?.deployUrl ?? null,
    score: biz?.score ?? null,
    websiteVerdict: snapshot.websiteVerdict,
    queueReason:
      `site_ready: демо зібране і задеплоєне; поточний сайт — ${snapshot.websiteVerdict}; ` +
      `score ${biz?.score ?? '-'}`,
    needsEdit: draftFailure !== null,
    needsEditReason: draftFailure === null ? null
      : 'Текст не написався автоматично — це шаблон-заготовка. '
        + 'Перепиши повідомлення перед підтвердженням.',
  };

  return { payload, snapshot, project, selection };
}

export async function requestApprovalHandler(job: JobPayload): Promise<void> {
  const businessId = job.businessId!;

  const { payload, snapshot } = await prepareApproval(businessId);
  // Serialize by business so concurrent legacy deliveries cannot both observe
  // "no pending approval" and create two cards that can be approved.
  const approval = await db.transaction(async (tx) => {
    const [business] = await tx.select({ id: schema.businesses.id })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1)
      .for('update');
    if (!business) throw new Error(`business not found: ${businessId}`);
    const [pending] = await tx.select().from(schema.approvals)
      .where(and(
        eq(schema.approvals.businessId, businessId),
        eq(schema.approvals.kind, 'outreach'),
        isNull(schema.approvals.decision),
      ))
      .orderBy(desc(schema.approvals.createdAt))
      .limit(1)
      .for('update');
    if (pending) {
      const [updated] = await tx.update(schema.approvals).set({ payload })
        .where(eq(schema.approvals.id, pending.id))
        .returning({ id: schema.approvals.id });
      if (!updated) throw new Error(`failed to refresh approval ${pending.id}`);
      return { id: updated.id, reused: true };
    }
    const [created] = await tx.insert(schema.approvals)
      .values({ businessId, kind: 'outreach', payload })
      .returning({ id: schema.approvals.id });
    if (!created) throw new Error(`failed to create approval for ${businessId}`);
    return { id: created.id, reused: false };
  });

  await notifyDemoReady({
    businessId,
    name: snapshot.name,
    score: payload.score,
    channel: payload.draft.channel,
    channelReason: payload.channelReason,
    demoUrl: payload.demoUrl,
  }).catch((err) => log.warn('demo-ready notification failed', { businessId, err: String(err) }));

  log.info('approval requested', {
    businessId, approvalId: approval.id, channel: payload.draft.channel, reused: approval.reused,
  });
}
