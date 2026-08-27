/**
 * Stage 7 — deterministic scoring + INDEPENDENT QA (spec §4).
 *
 * Three separate concepts, deliberately not collapsed:
 *   - qualified      : boolean, "is this a lead we want at all"
 *   - score          : priority ordering, deterministic, explainable breakdown
 *   - production_ready: stage 8's gate, "do we have enough to build a demo"
 *
 * The QA agent is a DIFFERENT persona from enrichment and re-reads the package
 * looking for provenance holes and hallucination smells. It may only report;
 * the status transition below is decided by code (spec §2.1).
 */
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { runAgent, z } from '../agents/agent.js';
import {
  businessTransitions,
  canContinueAfterTransition,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { advance } from '../orchestrator/router.js';
import { NeedsHumanError, type JobPayload } from '../orchestrator/queue.js';
import { getEnrichmentBarrier } from '../orchestrator/enrichmentBarrierRuntime.js';
import { log } from '../lib/logger.js';
import { translateQaNotes } from '../lib/translateNotes.js';

/**
 * Opportunity points: the weaker the current web presence, the more a demo
 * site is worth to this business. `working_good` means little opportunity.
 */
const SITE_OPPORTUNITY: Record<string, number> = {
  no_website: 30,
  broken: 26,
  working_with_https_issue: 20,
  outdated: 18,
  working_good: 2,
};

/** Live messenger channels are worth more than email (decision #8). */
const CHANNEL_POINTS: Record<string, number> = {
  whatsapp: 10, viber: 8, instagram: 6, facebook: 5, phone: 4, email: 4, contact_form: 1, website: 0, tiktok: 2, telegram: 4,
};

const QaSchema = z.object({
  provenanceOk: z.boolean(),
  hallucinationRisk: z.enum(['none', 'low', 'medium', 'high']),
  contradictions: z.array(z.string()),
  suspiciousFacts: z.array(z.object({ fact: z.string(), why: z.string() })),
  passed: z.boolean(),
  summary: z.string(),
});

const QA_SYSTEM = `You are an independent QA reviewer of a sales-lead evidence package. You did NOT build this package and you have no outside knowledge of this business.

Your ONLY job is to judge whether the package is internally sound:
1. PROVENANCE — every fact should carry a source. Facts marked "sourceId: null" are a provenance failure.
2. HALLUCINATION SMELL — do any facts look invented rather than extracted? Red flags: suspiciously round prices, generic marketing copy that no small business would write about itself, services that merely restate the category, review quotes that read like ad copy, contact details that follow a template.
3. CONTRADICTIONS — does the website verdict match the rest of the evidence? Do the services fit the category and the reviews? Do hours/address conflict between sources?
4. Missing data is NOT a failure. An honest, sparse package with declared gaps is GOOD. Only flag things that are present and wrong, or present and unsupported.

Set passed=false only for a real problem: provenance failures, medium/high hallucination risk, or a substantive contradiction. Sparse-but-honest passes.`;

/**
 * Statuses this stage may act on. A business that was reset, rejected or has
 * already moved on can still have a stale score job queued from an earlier run;
 * scoring it would attempt an illegal transition and fail the job for no reason.
 */
const SCOREABLE = new Set(['enriching', 'needs_review', 'qualified']);

export async function scoreAndQaHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);
  if (!SCOREABLE.has(biz.status)) {
    log.info('scoring skipped: business is not in a scoreable status', { businessId, status: biz.status });
    return;
  }
  if (typeof payload.enrichmentRunId !== 'string') {
    await businessTransitions.normal({
      businessId,
      expectedStatus,
      to: 'needs_review',
      actor: 'score-worker',
      reason: 'legacy score job has no enrichment barrier; evidence completeness is unknown',
    });
    throw new NeedsHumanError(`score job for ${businessId} has no enrichmentRunId`);
  }
  const barrier = await getEnrichmentBarrier();
  if (!await barrier.isScoreCurrent({ runId: payload.enrichmentRunId, businessId })) {
    log.info('stale score generation skipped', {
      businessId,
      enrichmentRunId: payload.enrichmentRunId,
    });
    return;
  }

  const [audit] = await db.select().from(schema.websiteAudits)
    .where(eq(schema.websiteAudits.businessId, businessId))
    .orderBy(desc(schema.websiteAudits.auditedAt)).limit(1);
  const facts = await db.select().from(schema.businessFacts).where(eq(schema.businessFacts.businessId, businessId));
  const contacts = await db.select().from(schema.businessContacts).where(eq(schema.businessContacts.businessId, businessId));
  const assetRows = await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));

  const services = facts.filter((f) => f.key === 'service');
  const reviews = facts.filter((f) => f.key === 'review' || f.key === 'review_excerpt');
  const verifiedContacts = contacts.filter((c) => c.verified);
  // channels we can actually open a conversation on (a bare website URL is not one)
  const reachable = verifiedContacts.filter((c) => c.channel !== 'website');
  const verdict = audit?.verdict ?? 'no_website';

  // ── deterministic score (max 100) ────────────────────────────────────────
  const distinctChannels = [...new Set(reachable.map((c) => c.channel))];
  const breakdown: Record<string, number> = {
    site_opportunity: SITE_OPPORTUNITY[verdict] ?? 15,
    contactability: Math.min(distinctChannels.reduce((sum, ch) => sum + (CHANNEL_POINTS[ch] ?? 2), 0), 25),
    content_richness: Math.min(services.length * 3 + reviews.length + assetRows.length, 25),
    business_health: Math.min(
      ((biz.rating ?? 0) >= 4.5 ? 12 : (biz.rating ?? 0) >= 4 ? 8 : 4)
      + Math.min((biz.reviewCount ?? 0) / 25, 8),
      20,
    ),
  };
  const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0) * 10) / 10;

  // ── qualification (boolean, independent of score) ────────────────────────
  const reasons: string[] = [];
  if (verdict === 'working_good') reasons.push('already_has_a_good_modern_site_no_opportunity');
  if (reachable.length === 0) reasons.push('no_reachable_contact_channel');
  const qualified = verdict !== 'working_good' && reachable.length > 0;

  // ── independent QA agent ─────────────────────────────────────────────────
  // Facts are handed over WITH their provenance so the agent can audit it.
  const factsForQa = facts.map((f) => ({
    key: f.key,
    value: typeof f.value === 'string' ? f.value.slice(0, 400) : f.value,
    sourceId: f.sourceId,
    extractionMethod: f.extractionMethod,
    confidence: f.confidence,
  }));

  let qaPassed: boolean | null = null;
  let qaNotes = '';
  try {
    const qa = await runAgent(
      'independent-qa',
      QA_SYSTEM,
      JSON.stringify({
        business: {
          name: biz.name, category: biz.category, address: biz.address,
          rating: biz.rating, reviewCount: biz.reviewCount, ownedDomain: biz.domain,
        },
        websiteAudit: { verdict, bestEndpoint: audit?.bestEndpoint ?? null, notes: audit?.notes ?? null },
        facts: factsForQa,
        contacts: contacts.map((c) => ({ channel: c.channel, value: c.value, sourceId: c.sourceId, verified: c.verified })),
        assets: assetRows.map((a) => ({ usage: a.intendedUsage, w: a.width, h: a.height, sourceType: a.sourceType, aiGenerated: a.aiGenerated })),
      }, null, 2).slice(0, 120_000),
      QaSchema,
      { kind: 'qa' },
    );
    qaPassed = qa.passed;
    qaNotes = [
      `risk=${qa.hallucinationRisk}`,
      `provenanceOk=${qa.provenanceOk}`,
      qa.summary,
      ...qa.contradictions.map((c) => `CONTRADICTION: ${c}`),
      ...qa.suspiciousFacts.map((s) => `SUSPICIOUS: ${s.fact} — ${s.why}`),
    ].join(' | ').slice(0, 2000);
  } catch (err: unknown) {
    // A rate limit must bubble: the queue parks the job in retry_wait (spec §2.3).
    if ((err as { code?: string })?.code === 'RATE_LIMITED') throw err;
    log.warn('qa agent failed', { businessId, err: String(err).slice(0, 300) });
    qaNotes = `qa agent unavailable: ${String(err).slice(0, 300)}`;
  }

  // The critic writes English by design (it reasons about provenance, not about
  // the business), and Roman reads this console in Ukrainian. The English stays
  // as the record of what the critic actually said; the Ukrainian is what the
  // Факти tab leads with. `translateQaNotes` preserves the `risk=` /
  // `CONTRADICTION:` structure the UI parses, and returns null rather than
  // throwing — an untranslated note is cosmetic, a failed scoring is not.
  const qaNotesUk = await translateQaNotes(
    qaNotes,
    `fact-check findings about "${biz.name}", a ${biz.category ?? 'local business'}`,
  );

  // ── code decides the transition; the agent only explained ────────────────
  //
  // Stage 7 never hard-rejects. The spec assigns `rejected` to stage 3, where
  // the rules are objective (closed, chain, wrong category, unreachable); here
  // the calls are judgement — "their existing site is good enough that a demo
  // has no hook" is exactly the sort of thing Roman may disagree with on a
  // business he wants anyway, and `rejected` is terminal with no way back.
  // So a stage-7 no goes to `needs_review` with the reason recorded, and the
  // decision stays reversible in the UI.
  const target = !qualified || qaPassed !== true ? 'needs_review' : 'qualified';
  const transitionReason = !qualified
    ? `not qualified: ${reasons.join(',')}`
    : qaPassed === false
      ? `QA failed: ${qaNotes.slice(0, 250)}`
      : qaPassed === null
        ? 'QA agent unavailable — package not independently verified'
        : `score=${score}`;
  let transitioned: Awaited<ReturnType<typeof businessTransitions.normal>> | null = null;
  const committed = await barrier.commitScore(
    { runId: payload.enrichmentRunId, businessId },
    async (tx) => {
      await tx.insert(schema.qualifications).values({
        businessId, stage: 'full', qualified, reasons, score, scoreBreakdown: breakdown,
        qaPassed, qaNotes, qaNotesUk,
      });
      await tx.update(schema.businesses)
        .set({ score, scoreBreakdown: breakdown, updatedAt: new Date() })
        .where(eq(schema.businesses.id, businessId));
      transitioned = await businessTransitions.normalInTransaction(tx, {
        businessId,
        expectedStatus,
        to: target,
        actor: 'score-worker',
        reason: transitionReason,
      });
    },
  );
  if (!committed) {
    log.info('score result discarded because its enrichment generation was superseded', {
      businessId,
      enrichmentRunId: payload.enrichmentRunId,
    });
    return;
  }
  if (!transitioned) throw new Error(`score transition result missing for ${businessId}`);
  log.info('scored', { businessId, score, breakdown, qualified, qaPassed });
  if (!canContinueAfterTransition(transitioned, { businessId, actor: 'score-worker' })) return;
  if (target === 'qualified') await advance(businessId); // -> readiness-gate
}
