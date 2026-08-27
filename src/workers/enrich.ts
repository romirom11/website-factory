/**
 * Stage 4 — deep enrichment (spec §4).
 *
 * Three evidence layers, in order of trust:
 *   1. gosom CSV (deterministic mining of the immutable discovery evidence:
 *      hours, Google attributes, up to ~10 user reviews, photos, owner);
 *   2. Playwright captures of the owned website and any publicly reachable
 *      social profile — stored as immutable raw HTML with a capture time;
 *   3. a single headless agent call that extracts identity/services/etc.
 *      ONLY from the text of layers 1-2.
 *
 * Invariants enforced here (spec §5):
 *   - every fact row carries a source_id; a fact the agent cites to an unknown
 *     source is DROPPED, not stored;
 *   - missing evidence => null + a `production_gaps` row, never an invention;
 *   - messengers are detected deterministically from markers in captured HTML,
 *     so a phone is never assumed to be on WhatsApp;
 *   - a catalog/booking profile is not an owned website.
 */
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getObject } from '../lib/storage.js';
import { runAgent, z } from '../agents/agent.js';
import {
  businessTransitions,
  canContinueAfterTransition,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { enqueue, type JobPayload } from '../orchestrator/queue.js';
import { log } from '../lib/logger.js';
import { config } from '../config.js';
import {
  parseGosomCsv, findRecord, renderRecordForPrompt, type GosomRecord,
} from '../enrichment/gosomEvidence.js';
import {
  detectContacts, classifySocialUrl, cleanProfileUrl, type ContactChannel,
} from '../enrichment/messengers.js';
import {
  launchBrowser, newCapturePage, capturePage, collectPageImages, type CapturedSource,
} from '../enrichment/capture.js';
import { checkGrounding, checkQuoteGrounding, stripGloss } from '../enrichment/grounding.js';
import { discoverSocials, existingSocialPlatforms } from '../enrichment/socialDiscovery.js';
import { extractBrandIdentity } from '../enrichment/brandIdentity.js';
import { translateToUkrainian } from '../lib/translateNotes.js';

/**
 * The agent's output contract. Note what is NOT here: no free-form "notes"
 * field the model could smuggle claims into, and every extracted item is
 * required to carry the sourceRef it came from.
 */
const EnrichmentSchema = z.object({
  identity: z.object({
    /** The trading name as it appears in the evidence, if it differs from the listing. */
    brandName: z.string().nullable(),
    tagline: z.string().nullable(),
    /** 1-3 sentences, strictly paraphrasing the evidence. */
    description: z.string().nullable(),
    sourceRef: z.string().nullable(),
  }),
  services: z.array(z.object({
    name: z.string(),
    /** Only when a price is literally printed in the evidence. */
    price: z.string().nullable(),
    sourceRef: z.string(),
  })),
  /** Languages the business communicates in, as evidenced by the page text. */
  languages: z.array(z.string()),
  /** Free-form summary of opening hours ONLY if the evidence states them. */
  hoursSummary: z.object({ value: z.string(), sourceRef: z.string() }).nullable(),
  addressConfirmed: z.object({ value: z.string(), sourceRef: z.string() }).nullable(),
  /** Themes customers repeat, each backed by a real review. */
  reviewHighlights: z.array(z.object({
    quote: z.string(),
    theme: z.string(),
    sentiment: z.enum(['positive', 'negative', 'mixed']),
    sourceRef: z.string(),
  })),
  /** What the business says about itself: team, story, specialities. */
  about: z.array(z.object({ statement: z.string(), sourceRef: z.string() })),
  /** Things a demo site would need but the evidence does not contain. */
  gaps: z.array(z.string()),
});

type EnrichmentResult = z.infer<typeof EnrichmentSchema>;

const SYSTEM_PROMPT = `You extract facts about a local business from captured evidence, for a sales-demo website.

ABSOLUTE RULES — violating any of these makes the whole extraction worthless:
1. Use ONLY the text inside the SOURCE blocks below. You have no other knowledge about this business.
2. Every item you output MUST carry the sourceRef ("S1", "S2", ...) of the block you read it in. If you cannot point at a block, DO NOT output the item.
3. NEVER invent, complete, or "reasonably assume": prices, emails, phone numbers, owner names, years in business, staff counts, certifications, awards, or services that are not named in the evidence.
4. If the evidence does not contain something, output null (or an empty array) and add a short line to "gaps". An empty result with honest gaps is a SUCCESS, not a failure.
5. Do not translate the business's own words into marketing copy. Paraphrase plainly, in the language of the evidence.
6. services = things the business actually offers, named in the evidence. Do not derive a service menu from the business category alone. A price goes in only when it is printed next to the service.
7. reviewHighlights must quote real review text from the evidence (trimmed is fine). Never write a review that is not there. Include negative ones if they are representative — this is an internal evidence package, not an advert.
8. A directory, booking or social profile is NOT the business's own website; do not describe it as one.`;

/** Facts the agent is not allowed to touch: mined verbatim from the CSV. */
interface DeterministicFacts {
  rows: (typeof schema.businessFacts.$inferInsert)[];
  contacts: Array<{ channel: ContactChannel; value: string; sourceId: number; verified: boolean }>;
  imageOffers: Array<{ url: string; kind: 'hero' | 'logo' | 'gallery'; sourceRef: string }>;
}

/**
 * Mines the gosom record. These rows are `deterministic` with confidence 1.0:
 * they are a verbatim copy of an immutable evidence file, not a model's reading.
 */
function mineGosomRecord(businessId: string, rec: GosomRecord, sourceId: number): DeterministicFacts {
  const rows: (typeof schema.businessFacts.$inferInsert)[] = [];
  const contacts: DeterministicFacts['contacts'] = [];
  const imageOffers: DeterministicFacts['imageOffers'] = [];
  const base = { businessId, sourceId, extractionMethod: 'deterministic', confidence: 1, verified: true } as const;

  if (rec.hours) {
    rows.push({ ...base, key: 'hours.structured', value: rec.hours.byDay });
  }
  if (rec.about.length) {
    rows.push({ ...base, key: 'google.attributes', value: rec.about });
    // enabled amenities are usable site content ("wheelchair access", "card payments")
    for (const a of rec.about.filter((x) => x.enabled)) {
      rows.push({ ...base, key: 'amenity', value: { group: a.group, name: a.name, values: a.values ?? null }, confidence: 0.95 });
    }
  }
  if (rec.reviewsPerRating) rows.push({ ...base, key: 'reviews.distribution', value: rec.reviewsPerRating });
  if (rec.completeAddress) rows.push({ ...base, key: 'address.structured', value: rec.completeAddress });
  if (rec.owner?.name) rows.push({ ...base, key: 'google.owner_profile', value: rec.owner });
  if (rec.priceRange) rows.push({ ...base, key: 'price_range', value: rec.priceRange });
  if (rec.descriptions) rows.push({ ...base, key: 'google.description', value: rec.descriptions });
  if (rec.menuLink) rows.push({ ...base, key: 'google.menu_link', value: rec.menuLink });
  if (rec.timezone) rows.push({ ...base, key: 'timezone', value: rec.timezone });

  // Reviews are stored verbatim — the demo site may quote them, so provenance matters.
  for (const r of rec.reviews) {
    rows.push({
      ...base,
      key: 'review',
      value: { author: r.name, rating: r.rating, text: r.text, when: r.when, images: r.images },
    });
  }

  // Contacts straight from the listing.
  if (rec.phone) contacts.push({ channel: 'phone', value: rec.phone, sourceId, verified: true });
  for (const e of rec.emails) contacts.push({ channel: 'email', value: e.toLowerCase(), sourceId, verified: true });
  if (rec.website) {
    const social = classifySocialUrl(rec.website);
    if (social) {
      // The maps "website" field pointing at Instagram is itself the evidence
      // that this profile is the business's public presence.
      contacts.push({ channel: social, value: cleanProfileUrl(rec.website), sourceId, verified: true });
    } else {
      contacts.push({ channel: 'website', value: rec.website, sourceId, verified: true });
    }
  }

  // Photos offered to the asset collector (stage 5).
  if (rec.thumbnail) imageOffers.push({ url: rec.thumbnail, kind: 'hero', sourceRef: 'gosom' });
  for (const img of rec.images) {
    const t = (img.title ?? '').toLowerCase();
    const kind: 'hero' | 'logo' | 'gallery' = /λογότυπ|logo/.test(t) ? 'logo' : 'gallery';
    imageOffers.push({ url: img.url, kind, sourceRef: 'gosom' });
  }
  return { rows, contacts, imageOffers };
}

/** Loads the discovery CSV evidence for a business and finds its record. */
async function loadGosomEvidence(biz: typeof schema.businesses.$inferSelect): Promise<{ rec: GosomRecord; sourceId: number } | null> {
  const sources = await db.select().from(schema.businessSources)
    .where(and(
      eq(schema.businessSources.businessId, biz.id),
      eq(schema.businessSources.method, 'gosom_api'),
    ));
  for (const src of sources) {
    if (!src.rawObjectKey) continue;
    try {
      const csv = (await getObject('raw', src.rawObjectKey)).toString('utf8');
      const rec = findRecord(parseGosomCsv(csv), biz);
      if (rec) return { rec, sourceId: src.id };
    } catch (err) {
      log.warn('gosom evidence unreadable', { businessId: biz.id, key: src.rawObjectKey, err: String(err).slice(0, 200) });
    }
  }
  return null;
}

/** Which pages are worth capturing: the owned site plus published social profiles. */
function captureTargets(
  biz: typeof schema.businesses.$inferSelect,
  rec: GosomRecord | null,
): Array<{ url: string; sourceType: 'owned_website' | 'instagram' | 'facebook' | 'tiktok' | 'telegram' | 'directory' }> {
  const targets: ReturnType<typeof captureTargets> = [];
  const seen = new Set<string>();
  const add = (url: string, sourceType: ReturnType<typeof captureTargets>[number]['sourceType']) => {
    const key = cleanProfileUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ url, sourceType });
  };

  // `domain` is set by normalize only for OWNED domains (directories excluded).
  if (biz.domain) add(`https://${biz.domain}`, 'owned_website');

  const websiteField = rec?.website ?? biz.websiteUrl;
  if (websiteField) {
    const social = classifySocialUrl(websiteField);
    if (social) add(websiteField, social as 'instagram' | 'facebook' | 'tiktok' | 'telegram');
    else if (!biz.domain) add(websiteField, 'directory'); // booking/catalog profile: evidence, not an owned site
  }
  return targets;
}

/**
 * Statuses enrichment may act on.
 *
 * A business that has already moved on (production_ready, site_in_progress,
 * site_ready…) can still have a stale `enrich` job queued from an earlier run.
 * Re-enriching it would attempt an illegal transition and fail the job — and,
 * worse, would clear the facts a build is currently reading. Observed 29 times
 * on the real run, so the guard is not theoretical.
 */
const ENRICHABLE = new Set(['prequalified', 'enriching', 'needs_review', 'qualified']);

export async function enrichHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);
  if (!ENRICHABLE.has(expectedStatus)) {
    log.info('enrichment skipped: business has already moved past this stage', { businessId, status: biz.status });
    return;
  }
  const started = await businessTransitions.normal({
    businessId,
    expectedStatus,
    to: 'enriching',
    actor: 'enrich-worker',
  });
  if (!canContinueAfterTransition(started, { businessId, actor: 'enrich-worker' })) return;

  // Re-running enrichment must not duplicate rows (jobs retry, spec §7).
  await db.delete(schema.businessFacts).where(eq(schema.businessFacts.businessId, businessId));

  // ── Layer 1: deterministic mining of the discovery evidence ───────────────
  const gosom = await loadGosomEvidence(biz);
  const mined: DeterministicFacts = gosom
    ? mineGosomRecord(businessId, gosom.rec, gosom.sourceId)
    : { rows: [], contacts: [], imageOffers: [] };
  if (!gosom) log.warn('no gosom evidence for business', { businessId });

  // ── Layer 2: browser capture of the owned site + socials ─────────────────
  const captured: CapturedSource[] = [];
  const pageImages: Array<{ url: string; kind: 'hero' | 'logo' | 'gallery'; sourceRef: string }> = [];
  const targets = captureTargets(biz, gosom?.rec ?? null);

  if (targets.length) {
    const browser = await launchBrowser();
    try {
      const page = await newCapturePage(browser);
      for (const t of targets) {
        const c = await capturePage(businessId, t, page);
        if (!c) continue;
        captured.push(c);
        if (t.sourceType === 'owned_website') {
          for (const img of await collectPageImages(page)) {
            pageImages.push({ url: img.url, kind: img.kind, sourceRef: c.ref });
          }
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // Label sources for the prompt. S0 is always the immutable discovery evidence.
  const refs = new Map<string, number>();
  if (gosom) refs.set('S0', gosom.sourceId);
  captured.forEach((c, i) => {
    c.ref = `S${i + 1}`;
    refs.set(c.ref, c.sourceId);
  });
  // page images were collected before refs were assigned; attach the site ref
  const siteRef = captured.find((c) => c.sourceType === 'owned_website')?.ref;
  for (const img of pageImages) img.sourceRef = siteRef ?? 'S1';

  // ── Deterministic messenger/contact detection from captured HTML ──────────
  //
  // Profiles we can already attribute to the business: the URL the listing
  // published, and the page we actually navigated to. On a third-party page
  // (a Treatwell listing, a Facebook profile) only these are the business's —
  // everything else in the chrome belongs to the platform.
  const knownProfiles = [
    ...(gosom?.rec.website ? [gosom.rec.website] : []),
    ...(biz.websiteUrl ? [biz.websiteUrl] : []),
    ...captured.map((c) => c.finalUrl),
  ];
  const detected: DeterministicFacts['contacts'] = [];
  for (const c of captured) {
    for (const hit of detectContacts(c.html, { sourceType: c.sourceType, knownProfiles })) {
      detected.push({ channel: hit.channel, value: hit.value, sourceId: c.sourceId, verified: true });
      mined.rows.push({
        businessId, key: `contact_marker.${hit.channel}`,
        value: { value: hit.value, evidence: hit.evidence, foundOn: c.finalUrl },
        sourceId: c.sourceId, extractionMethod: 'deterministic', confidence: 1, verified: true,
      });
    }
  }

  if (!gosom && captured.length === 0) {
    const transitioned = await businessTransitions.normal({
      businessId,
      expectedStatus: 'enriching',
      to: 'needs_review',
      actor: 'enrich-worker',
      reason: 'no evidence available (no gosom record, no page capturable)',
    });
    canContinueAfterTransition(transitioned, { businessId, actor: 'enrich-worker' });
    return;
  }

  // ── Layer 3: the agent, seeing ONLY the captured text ────────────────────
  //
  // The rendering of S0 must be byte-identical to the one the grounding check
  // later validates against (`sourceTextFor`). If the check saw MORE reviews
  // than the prompt did, a quote could be "verified" against text the agent was
  // never shown; if it saw fewer, a legitimate quote would be dropped.
  const gosomBlock = gosom
    ? renderRecordForPrompt(gosom.rec, { maxReviews: config.pipeline.maxReviewsInPrompt })
    : '';
  // Hard prompt budget. One pathological page (inline base64 images, a JS
  // bundle leaking into innerText) once produced a 1.6M-token prompt and the
  // whole business parked in needs_human. Evidence text is clamped BEFORE both
  // the prompt AND the grounding check, so they keep seeing identical bytes.
  const PER_SOURCE_CHARS = 20_000;
  const TOTAL_EVIDENCE_CHARS = 120_000;
  let budget = TOTAL_EVIDENCE_CHARS;
  for (const c of captured) {
    const clamped = c.text.slice(0, Math.max(0, Math.min(PER_SOURCE_CHARS, budget)));
    if (clamped.length < c.text.length) {
      log.warn('evidence clamped for prompt budget', {
        businessId, ref: c.ref, from: c.text.length, to: clamped.length,
      });
      c.text = `${clamped}\n[… джерело обрізано до бюджету промпта; повний текст у raw evidence]`;
    }
    budget -= c.text.length;
  }

  const blocks: string[] = [];
  if (gosom) {
    blocks.push(`=== SOURCE S0 (Google Maps listing evidence, captured by the discovery crawler) ===\n${gosomBlock.slice(0, 40_000)}`);
  }
  for (const c of captured) {
    blocks.push(`=== SOURCE ${c.ref} (${c.sourceType}, url=${c.finalUrl}, captured ${c.capturedAt.toISOString()}) ===\n${c.text}`);
  }

  const result: EnrichmentResult = await runAgent(
    'enrichment',
    SYSTEM_PROMPT,
    [
      `Listing name: ${biz.name}`,
      `Listing category: ${biz.category ?? 'unknown'}`,
      `Listing address: ${biz.address ?? 'unknown'}`,
      `Owned website domain: ${biz.domain ?? 'none identified'}`,
      '',
      `You have ${blocks.length} source block(s). Cite each extracted item with its sourceRef.`,
      '',
      ...blocks,
    ].join('\n'),
    EnrichmentSchema,
    { kind: 'enrichment' },
  );

  // ── Persist: every agent fact must (a) resolve to a real source_id and
  //    (b) actually appear in that source's text ───────────────────────────
  //
  // (b) is not paranoia. On the first real run this exact prompt, for a salon
  // whose site listed 8 services, returned 10 — inventing "beard care" and
  // "moustache care": plausible for a barbershop, absent from every source.
  // The prompt asks the model not to invent; this check makes it impossible
  // for an invention to become a stored fact (spec §5).
  const factRows = [...mined.rows];
  let droppedForProvenance = 0;
  const droppedUngrounded: string[] = [];
  const resolve = (ref: string | null | undefined): number | null => {
    if (!ref) return null;
    return refs.get(ref.trim().toUpperCase()) ?? null;
  };
  /** Full text of a cited source, for the grounding check. */
  const sourceTextFor = (ref: string | null | undefined): string => {
    const r = ref?.trim().toUpperCase();
    // exactly what the agent was shown for S0 — see `gosomBlock` above
    if (r === 'S0') return gosomBlock;
    return captured.find((c) => c.ref === r)?.text ?? '';
  };

  /**
   * @param claimText text that must be traceable to the cited source; pass null
   *   to store without a grounding check (used only for structural values that
   *   are not natural-language claims, e.g. the detected language list).
   */
  const addAgentFact = (
    key: string,
    value: unknown,
    ref: string | null,
    confidence: number,
    claimText: string | null,
    mode: 'paraphrase' | 'quote' = 'paraphrase',
  ) => {
    const sourceId = resolve(ref);
    if (sourceId === null) { droppedForProvenance++; return; }
    if (claimText !== null) {
      const src = sourceTextFor(ref);
      const verdict = mode === 'quote'
        ? checkQuoteGrounding(claimText, src)
        : checkGrounding(claimText, src);
      if (!verdict.grounded) {
        droppedUngrounded.push(`${key}: "${claimText.slice(0, 80)}" (coverage ${verdict.coverage.toFixed(2)})`);
        return;
      }
    }
    factRows.push({ businessId, key, value: value as never, sourceId, extractionMethod: 'llm_structured', confidence, verified: true });
  };

  const id = result.identity;
  if (id.description) addAgentFact('identity.description', id.description, id.sourceRef, 0.8, id.description);
  if (id.brandName) addAgentFact('identity.brand_name', id.brandName, id.sourceRef, 0.8, id.brandName);
  if (id.tagline) addAgentFact('identity.tagline', id.tagline, id.sourceRef, 0.75, id.tagline, 'quote');
  if (result.hoursSummary) {
    // Hours are a RESTATEMENT of `hours.structured`, which is already mined
    // verbatim from the evidence with confidence 1. The model reformats them
    // into a readable line ("Mon-Fri 10:00-18:30"), so its words legitimately
    // differ from the Greek source and a lexical check is the wrong instrument.
    // The structured fact is the authority; this is a convenience rendering, so
    // it is only kept when the structured hours exist to back it.
    const hasStructuredHours = mined.rows.some((r) => r.key === 'hours.structured');
    if (hasStructuredHours) {
      addAgentFact('hours', result.hoursSummary.value, result.hoursSummary.sourceRef, 0.7, null);
    } else {
      addAgentFact('hours', result.hoursSummary.value, result.hoursSummary.sourceRef, 0.8, result.hoursSummary.value);
    }
  }
  if (result.addressConfirmed) addAgentFact('address.confirmed', result.addressConfirmed.value, result.addressConfirmed.sourceRef, 0.8, result.addressConfirmed.value);
  for (const s of result.services) {
    // A parenthetical gloss is the model's own expansion, not evidence: the
    // Instagram bio "Nails • Lashes • PMU • SMP" became "PMU (Permanent Make-Up)"
    // and "SMP (Scalp Micropigmentation)" — the latter word appears nowhere.
    // Ground the head term and store the gloss only when it too is supported.
    const { head, gloss } = stripGloss(s.name);
    const glossOk = gloss !== null && checkGrounding(gloss, sourceTextFor(s.sourceRef)).grounded;
    const name = glossOk ? s.name : head;
    // The price is part of the claim: an invented number must fail with it.
    const claim = s.price ? `${head} ${s.price}` : head;
    addAgentFact('service', { name, price: s.price }, s.sourceRef, s.price ? 0.85 : 0.8, claim);
  }
  for (const r of result.reviewHighlights) {
    // A quote shown back to the business must be near-verbatim, not paraphrased.
    addAgentFact('review_excerpt', { text: r.quote, theme: r.theme, sentiment: r.sentiment, rating: null }, r.sourceRef, 0.8, r.quote, 'quote');
  }
  for (const a of result.about) {
    // Same bilingual-gloss handling as services: keep the evidenced head term.
    const { head, gloss } = stripGloss(a.statement);
    const glossOk = gloss !== null && checkGrounding(gloss, sourceTextFor(a.sourceRef)).grounded;
    addAgentFact('about', glossOk ? a.statement : head, a.sourceRef, 0.75, head);
  }
  if (result.languages.length) {
    // Not a natural-language claim: a language list has no text to trace.
    const primary = captured[0]?.ref ?? 'S0';
    addAgentFact('languages', result.languages, primary, 0.7, null);
  }

  if (droppedUngrounded.length) {
    log.warn('dropped ungrounded agent claims', { businessId, count: droppedUngrounded.length, claims: droppedUngrounded.slice(0, 10) });
  }

  if (factRows.length) await db.insert(schema.businessFacts).values(factRows);

  // ── Contacts: deterministic only, deduped, never invented by the agent ───
  const existing = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.businessId, businessId));
  const seenContacts = new Set(existing.map((c) => `${c.channel}:${c.value.toLowerCase()}`));
  const contactRows: (typeof schema.businessContacts.$inferInsert)[] = [];
  for (const c of [...mined.contacts, ...detected]) {
    const key = `${c.channel}:${c.value.toLowerCase()}`;
    if (seenContacts.has(key)) continue;
    seenContacts.add(key);
    contactRows.push({ businessId, channel: c.channel, value: c.value, sourceId: c.sourceId, verified: c.verified });
  }
  if (contactRows.length) await db.insert(schema.businessContacts).values(contactRows);

  // ── Social discovery: find the profiles the listing never published ──────
  //
  // Runs only when the business still has no verified Instagram/Facebook
  // contact after everything above — for a business whose maps `website` field
  // already points at its Instagram, this whole step is skipped.
  //
  // Roman's finding on the real Patras run: "exte hair design" has both a
  // Facebook page and an Instagram profile, and the factory had neither,
  // because socials only ever came from the listing or the owned website. In
  // Patras the messenger channel IS Instagram (decision #8), so this was a
  // missing outreach channel, not a cosmetic gap.
  //
  // It is deliberately best-effort: search engines rate-limit, and a business
  // must never fail enrichment because Brave answered 429.
  let socialGap: string | null = null;
  if (config.socialDiscovery.enabled) {
    const alreadyHave = await existingSocialPlatforms(businessId);
    if (alreadyHave.includes('instagram') && alreadyHave.includes('facebook')) {
      log.info('social discovery skipped: verified socials already present', { businessId, alreadyHave });
    } else {
      const [campaign] = await db.select().from(schema.campaigns)
        .where(eq(schema.campaigns.id, biz.campaignId));
      const social = await discoverSocials({
        id: businessId,
        name: biz.name,
        city: campaign?.city ?? '',
        phone: biz.phone,
        normalizedPhone: biz.normalizedPhone,
        address: biz.address,
        domain: biz.domain,
        websiteUrl: biz.websiteUrl,
        category: biz.category,
      }, { skipPlatforms: alreadyHave });
      socialGap = social.gap;
      log.info('social discovery done', {
        businessId,
        candidates: social.candidates.length,
        profilesRead: social.profiles.length,
        strong: social.profiles.filter((p) => p.verdict.strength === 'strong').length,
        contactsWritten: social.contactsWritten.length,
        gap: social.gap,
      });
      if (social.notes.length) log.warn('social discovery notes', { businessId, notes: social.notes.slice(0, 6) });
    }
  }

  // ── Brand identity: the business's own colours, fonts and voice ──────────
  //
  // Runs LAST in enrichment, after the captures and the social discovery whose
  // evidence it reads. `collect-assets` has not run yet at this point, so this
  // pass sees the captured PAGES but no downloaded logo file — the site's
  // declared colours, the profile avatar and the voice, which is the half that
  // photographs cannot supply. `collectAssetsHandler` re-runs the colour half
  // the moment the logo lands, which is what upgrades the palette from
  // photo-derived to logo-derived.
  //
  // Non-fatal by construction: `extractBrandIdentity` never throws for ordinary
  // failure, and a `brand_unresolved` gap is a fact about the business (it
  // published no identity we could measure), not a pipeline error.
  let brandGap: string | null = null;
  try {
    const brand = await extractBrandIdentity(businessId);
    brandGap = brand.gap;
    log.info('brand identity extracted', {
      businessId,
      paletteSource: brand.paletteSource,
      primary: brand.primary?.hex ?? null,
      accent: brand.accent?.hex ?? null,
      fonts: brand.fontsSeen?.fonts.length ?? 0,
      voice: brand.voice?.tone ?? null,
      gap: brand.gap,
    });
    if (brand.notes.length) log.warn('brand identity notes', { businessId, notes: brand.notes.slice(0, 6) });
  } catch (err) {
    // Defensive: a programming error in extraction must not cost the enrichment
    // that already succeeded.
    brandGap = 'brand_unresolved';
    log.warn('brand identity extraction threw', { businessId, err: String(err).slice(0, 200) });
  }

  // ── Gaps the agent honestly reported ─────────────────────────────────────
  await db.update(schema.productionGaps)
    .set({ resolved: true })
    .where(and(
      eq(schema.productionGaps.businessId, businessId),
      eq(schema.productionGaps.blockerLevel, 'soft'),
      eq(schema.productionGaps.resolved, false),
    ));
  //
  // The agent writes these in the language of the EVIDENCE (SYSTEM_PROMPT rule
  // 5), so for a Patras salon they are Greek. Roman reads the console in
  // Ukrainian, so each gap gets a Ukrainian rendering stored next to it — the
  // original stays as the record of what the agent actually said. One batched
  // call for the whole business, and it is non-fatal: a translation failure
  // leaves `gapUk` null and the UI falls back to the original text.
  const softGapTexts = [
    ...result.gaps.slice(0, 12).map((g) => g.slice(0, 200)),
    // "We looked for a social profile and could not confirm one" is a fact worth
    // recording: it is what distinguishes a business with no online presence
    // from one the factory simply never searched for.
    ...(socialGap ? [socialGap] : []),
    // Same reasoning for the brand: "we looked and this business publishes no
    // logo, no site colours and no bio" is what tells the art director to build
    // an identity rather than match one.
    ...(brandGap ? [brandGap] : []),
  ];
  const softGapUk = await translateToUkrainian(
    softGapTexts,
    `evidence gaps for "${biz.name}", a ${biz.category ?? 'local business'}`,
  );
  for (const [i, gap] of softGapTexts.entries()) {
    await db.insert(schema.productionGaps).values({
      businessId, gap, gapUk: softGapUk[i] ?? null, blockerLevel: 'soft',
    });
  }

  log.info('enrichment done', {
    businessId,
    gosomEvidence: !!gosom,
    captured: captured.length,
    facts: factRows.length,
    agentServices: result.services.length,
    contacts: contactRows.length,
    droppedForProvenance,
    droppedUngrounded: droppedUngrounded.length,
    gaps: result.gaps.length,
  });

  // Stage 5 + 6 run next; the audit worker chains into scoring.
  const stillCurrent = await businessTransitions.normal({
    businessId,
    expectedStatus: 'enriching',
    to: 'enriching',
    actor: 'enrich-worker',
  });
  if (!canContinueAfterTransition(stillCurrent, { businessId, actor: 'enrich-worker' })) return;
  await enqueue('collect-assets', {
    businessId,
    campaignId: biz.campaignId,
    imageUrls: [...mined.imageOffers, ...pageImages] as unknown as Record<string, unknown>[],
  });
  await enqueue('audit-website', { businessId, campaignId: biz.campaignId });
}
