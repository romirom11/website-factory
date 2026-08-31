/**
 * Stage 8 — production-readiness gate (spec §4).
 *
 * `qualified` means "worth pursuing". `production_ready` means "we hold enough
 * VERIFIED material to build an honest demo site". They are deliberately not
 * the same thing: a business we would love to win can still lack the evidence
 * to show it something real, and in that case it waits with named gaps rather
 * than getting a demo padded with invention.
 *
 * Pure code. No agent decides this.
 */
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import {
  businessTransitions,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { commitWorkflow, type JobPayload } from '../orchestrator/queue.js';
import {
  buildJobPriority,
  isAutoBuildEligible,
  normalizeBuildPolicy,
} from '../orchestrator/buildPolicy.js';
import { log } from '../lib/logger.js';
import { config } from '../config.js';

/** The six hard gates from spec §4 stage 8. */
export const READINESS_GAPS = [
  'identity', 'verified_contact', 'services_min3', 'assets_min3', 'hero_or_logo', 'review_context',
] as const;

export interface ReadinessReport {
  gaps: string[];
  counts: Record<string, number>;
}

/** Pure, testable: decides the gaps from already-loaded evidence. */
export function evaluateReadiness(input: {
  facts: Array<{ key: string; verified: boolean; sourceId: number | null }>;
  contacts: Array<{ channel: string; verified: boolean }>;
  assets: Array<{ intendedUsage: string; width: number | null; height: number | null; aiGenerated: boolean }>;
}): ReadinessReport {
  const { facts, contacts, assets } = input;
  // Only sourced facts count toward readiness (spec §5: no source => not verified).
  const sourced = facts.filter((f) => f.sourceId !== null);
  const services = sourced.filter((f) => f.key === 'service');
  const reviews = sourced.filter((f) => f.key === 'review' || f.key === 'review_excerpt');
  const identity = sourced.some((f) => f.key === 'identity.description' || f.key === 'about' || f.key === 'google.description');

  // A demo must be reachable by a real channel; a website URL is not a contact.
  const reachable = contacts.filter((c) => c.verified && c.channel !== 'website');

  // AI-generated media can never satisfy a "we have real imagery" gate
  // (spec §2.5: AI media is decorative and never passes as a business photo).
  const realAssets = assets.filter((a) => !a.aiGenerated);
  const { minServices, minAssets, minReviews, heroMinEdge } = config.pipeline.readiness;
  const heroOrLogo = realAssets.some((a) =>
    a.intendedUsage === 'logo'
    || (['hero', 'gallery'].includes(a.intendedUsage) && (a.width ?? 0) >= heroMinEdge));

  const gaps: string[] = [];
  if (!identity) gaps.push('identity');
  if (reachable.length === 0) gaps.push('verified_contact');
  if (services.length < minServices) gaps.push('services_min3');
  if (realAssets.length < minAssets) gaps.push('assets_min3');
  if (!heroOrLogo) gaps.push('hero_or_logo');
  if (reviews.length < minReviews) gaps.push('review_context');

  return {
    gaps,
    counts: {
      services: services.length,
      reviews: reviews.length,
      assets: realAssets.length,
      reachableContacts: reachable.length,
      sourcedFacts: sourced.length,
    },
  };
}

/** Statuses from which the gate can still move a business forward. */
const GATEABLE = new Set(['qualified', 'needs_review']);

export async function readinessHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);
  // A terminal business (rejected/duplicate/...) can still have a stale gate job
  // queued from an earlier run. Re-gating it would attempt an illegal transition,
  // so the job succeeds as a no-op instead of failing the queue.
  if (!GATEABLE.has(expectedStatus)) {
    log.info('readiness gate skipped: business is not in a gateable status', { businessId, status: biz.status });
    return;
  }

  const facts = await db.select().from(schema.businessFacts).where(eq(schema.businessFacts.businessId, businessId));
  const contacts = await db.select().from(schema.businessContacts).where(eq(schema.businessContacts.businessId, businessId));
  const assetRows = await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));

  const report = evaluateReadiness({ facts, contacts, assets: assetRows });

  let committed = false;
  await commitWorkflow(async (tx) => {
    const [locked] = await tx.select({
      status: schema.businesses.status,
      campaignId: schema.businesses.campaignId,
      score: schema.businesses.score,
    }).from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1)
      .for('update');
    if (!locked) throw new Error(`business not found: ${businessId}`);
    const lockedStatus = requireBusinessStatus(locked.status, `business ${businessId}`);
    if (!GATEABLE.has(lockedStatus)) return [];

    // A re-run supersedes old hard gaps. The gap set, status, history and any
    // build continuation are one decision rather than independently visible.
    await tx.update(schema.productionGaps)
      .set({ resolved: true })
      .where(and(
        eq(schema.productionGaps.businessId, businessId),
        eq(schema.productionGaps.blockerLevel, 'hard'),
        eq(schema.productionGaps.resolved, false),
      ));
    if (report.gaps.length) {
      await tx.insert(schema.productionGaps).values(
        report.gaps.map((gap) => ({ businessId, gap, blockerLevel: 'hard' })),
      );
    }

    const target = report.gaps.length ? 'needs_review' : 'production_ready';
    const transitioned = await businessTransitions.normalInTransaction(tx, {
      businessId,
      expectedStatus: lockedStatus,
      to: target,
      actor: 'readiness-gate',
      reason: report.gaps.length
        ? `gaps: ${report.gaps.join(',')}`
        : `all gates passed (${report.counts.services} services, ${report.counts.assets} assets)`,
    });
    if (transitioned.kind !== 'moved' && transitioned.kind !== 'already_at_target') {
      throw new Error(`readiness gate lost its locked transition for ${businessId}`);
    }
    committed = true;
    if (target !== 'production_ready') return [];

    const [campaign] = await tx.select({ autoBuild: schema.campaigns.autoBuild })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, locked.campaignId))
      .limit(1);
    const [audit] = await tx.select({ verdict: schema.websiteAudits.verdict })
      .from(schema.websiteAudits)
      .where(eq(schema.websiteAudits.businessId, businessId))
      .orderBy(desc(schema.websiteAudits.auditedAt))
      .limit(1);
    const policy = normalizeBuildPolicy(campaign?.autoBuild);
    const decision = isAutoBuildEligible({ policy, latestVerdict: audit?.verdict });
    if (!decision.eligible) return [];
    return [{
      name: 'content-and-design',
      payload: {
        businessId,
        campaignId: locked.campaignId,
        idempotencyKey: `content-and-design:${businessId}`,
      },
      options: {
        priority: buildJobPriority({ latestVerdict: audit?.verdict, score: locked.score }),
      },
    }];
  });
  if (!committed) {
    log.info('readiness result discarded: business already advanced', { businessId });
    return;
  }
  log.info(
    report.gaps.length ? 'not production ready' : 'production ready',
    { businessId, ...(report.gaps.length ? report : report.counts) },
  );
}
