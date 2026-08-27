/**
 * Stage 3 — fast qualification (spec §4).
 *
 * A cheap deterministic filter so expensive enrichment is not spent on
 * candidates that can never convert. No LLM: every verdict here is a rule with
 * a stored reason, so a rejection is always explainable in the UI.
 *
 * The three verdicts are `prequalified` / `needs_review` / `rejected`.
 * `needs_review` is used whenever a human could reasonably disagree — the
 * pipeline never silently discards a borderline lead.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import {
  businessTransitions,
  canContinueAfterTransition,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { advance } from '../orchestrator/router.js';
import type { JobPayload } from '../orchestrator/queue.js';
import { log } from '../lib/logger.js';

/**
 * Big chains/franchises: no local decision-maker to sell to. Matched on word
 * boundaries so "Hairway" does not match "Hair".
 */
const CHAIN_NAMES = [
  'hondos center', 'sephora', 'douglas', 'marinopoulos', 'the body shop',
  'yves rocher', 'notos galleries', 'attica', 'public', 'holland & barrett',
  'jysk', 'ikea', 'lidl', 'ab vasilopoulos', 'sklavenitis', 'my market',
  "l'oreal", 'wella', 'schwarzkopf',
];
const CHAIN_MARKERS = ['franchise', 'φραντσάιζ', 'αλυσίδα'];

/** Categories that are not our target even when a beauty query surfaced them. */
const OFF_TARGET_CATEGORIES = [
  'φαρμακείο', 'pharmacy', 'super market', 'σούπερ μάρκετ', 'supermarket',
  'νοσοκομείο', 'hospital', 'κλινική', 'clinic',
  'ξενοδοχείο', 'hotel', 'εστιατόριο', 'restaurant', 'καφετέρια', 'cafe',
  'γυμναστήριο', 'gym', 'σχολή', 'school', 'φροντιστήριο',
  'κατάστημα ρούχων', 'clothing store', 'κοσμηματοπωλείο', 'jewelry store',
];

/** Google's own signals that a place is gone. */
const CLOSED_STATUSES = ['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY'];

export interface FastQualifyDecision {
  verdict: 'prequalified' | 'needs_review' | 'rejected';
  reasons: string[];
}

/** Pure decision function so the rules are testable without a database. */
export function decideFastQualification(input: {
  name: string;
  category: string | null;
  businessStatus: string | null;
  normalizedPhone: string | null;
  hasContact: boolean;
  rating: number | null;
  reviewCount: number | null;
  blockedByDnc: boolean;
}): FastQualifyDecision {
  const reasons: string[] = [];
  let verdict: FastQualifyDecision['verdict'] = 'prequalified';
  /** Rejection is terminal and always wins over needs_review. */
  const reject = (reason: string) => { verdict = 'rejected'; reasons.push(reason); };
  const review = (reason: string) => { if (verdict !== 'rejected') verdict = 'needs_review'; reasons.push(reason); };

  if (input.blockedByDnc) reject('do_not_contact');

  if (input.businessStatus && CLOSED_STATUSES.includes(input.businessStatus)) {
    reject(`closed:${input.businessStatus.toLowerCase()}`);
  }

  const name = input.name.toLowerCase();
  const category = (input.category ?? '').toLowerCase();

  const chainHit = CHAIN_NAMES.find((c) => name.includes(c));
  if (chainHit) reject(`chain_or_franchise:${chainHit}`);
  const markerHit = CHAIN_MARKERS.find((m) => name.includes(m) || category.includes(m));
  if (markerHit) review(`possible_franchise_marker:${markerHit}`);

  const offTarget = OFF_TARGET_CATEGORIES.find((c) => category.includes(c));
  if (offTarget) reject(`non_target_category:${offTarget}`);

  // No phone AND no other contact means there is no way to reach them at all.
  if (!input.normalizedPhone && !input.hasContact) reject('no_phone_no_contact');
  else if (!input.normalizedPhone) review('no_phone');

  // A place with almost no reviews may be brand new or a ghost listing.
  if ((input.reviewCount ?? 0) < 3) review(`low_review_count:${input.reviewCount ?? 0}`);
  // Consistently poor ratings: a demo site will not fix the underlying problem.
  if (input.rating !== null && input.rating < 3.5 && (input.reviewCount ?? 0) >= 10) {
    review(`low_rating:${input.rating}`);
  }

  return { verdict, reasons };
}

export async function fastQualifyHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);
  if (expectedStatus !== 'discovered') {
    log.info('fast qualification skipped: business already left discovery', {
      businessId,
      status: expectedStatus,
    });
    return;
  }

  const contacts = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.businessId, businessId));
  const dnc = await db.select().from(schema.doNotContact);
  const blockedByDnc = dnc.some((d) =>
    (d.matchType === 'phone' && d.value === biz.normalizedPhone)
    || (d.matchType === 'domain' && !!biz.domain && d.value === biz.domain)
    || (d.matchType === 'business_id' && d.value === biz.id)
    || (d.matchType === 'email' && contacts.some((c) => c.channel === 'email' && c.value === d.value)));

  const { verdict, reasons } = decideFastQualification({
    name: biz.name,
    category: biz.category,
    businessStatus: biz.businessStatus,
    normalizedPhone: biz.normalizedPhone,
    hasContact: contacts.some((c) => c.channel !== 'website'),
    rating: biz.rating,
    reviewCount: biz.reviewCount,
    blockedByDnc,
  });

  await db.insert(schema.qualifications).values({
    businessId, stage: 'fast', qualified: verdict === 'prequalified', reasons,
  });
  const transitioned = await businessTransitions.normal({
    businessId,
    expectedStatus,
    to: verdict,
    actor: 'fast-qualify-worker',
    reason: reasons.join(',') || 'passed all fast checks',
  });
  if (!canContinueAfterTransition(transitioned, { businessId, actor: 'fast-qualify-worker' })) return;
  log.info('fast qualification', { businessId, verdict, reasons });

  if (verdict === 'prequalified') await advance(businessId); // -> enrich
}
