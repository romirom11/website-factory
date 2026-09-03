/**
 * Stage 9 — content brief + design contract (SPEC §4, §2.4).
 *
 * Three headless structured calls, then a deterministic decision:
 *   1. content brief   — written ONLY from the frozen snapshot, in the business's
 *                        language, with every allowed claim bound to source ids;
 *   2. art directions  — exactly 3 STRUCTURALLY different directions, each naming
 *                        a typography pair, a palette derived from real assets, a
 *                        motion concept, pool components and ONE curated reference;
 *   3. critique        — a separate call scores each direction on the §2.4 axes.
 *
 * The winner is then computed by `chooseDirection()` in code (src/build/rubric.ts).
 * The LLM explains; code decides — no model output can move a business between
 * stages or pick what gets built.
 *
 * Both documents are frozen into object storage and referenced from `site_projects`,
 * so a rebuild months later reproduces the same inputs.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getObject, putRaw } from '../lib/storage.js';
import { runAgent } from '../agents/agent.js';
import { createAgentInputWorkspace } from '../agents/transport.js';
import {
  businessTransitions,
  canContinueAfterTransition,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import {
  commitWorkflow,
  enqueue,
  NeedsHumanError,
  type JobPayload,
} from '../orchestrator/queue.js';
import { buildSnapshot, primaryContact, realPhotos, type BuildSnapshot } from '../build/snapshot.js';
import {
  ArtDirectionsSchema, ContentBriefSchema, DESIGN_CONTRACT_VERSION, DirectionCritiqueSchema,
  GREEK_SAFE_BODY, GREEK_SAFE_DISPLAY, GREEK_UNSAFE_NOTE,
} from '../build/schemas.js';
import { chooseDirection, routeDesignGate } from '../build/rubric.js';
import { buildLogPath, logStage } from '../build/buildLog.js';
import type { ArtDirection, ContentBrief, DirectionScore } from '../build/schemas.js';
import {
  HERO_MOTION_KINDS, MOTION_COMPONENTS, PHOTO_GRADES, WOW_MAX,
  loadCondensedNotes, loadMotionIndex, renderMotionIndexForPrompt, renderWowGate, renderWowRubric,
  shortlistReferences, type MotionRefIndexEntry,
} from '../build/motionRefs.js';
import {
  buildQueries, downloadRefs, renderGalleryBlock, searchInspiration, type DownloadedRef,
} from '../lib/landingGallery.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { JobSkippedError } from '../orchestrator/jobSkipped.js';

/**
 * Reference pack + component catalogue, in full.
 *
 * Decision #11 grounds the art director in the curated reference detail, so this
 * deliberately sends the whole pack rather than a digest. That briefly needed
 * trimming when `structured()` pinned `maxTurns: 1` and discarded answers written
 * on a second turn; the runtime now allows extra turns and salvages a valid
 * payload, so the full pack is back and the design call asks for `maxTurns: 3`.
 */
async function designContext(niche: string): Promise<{ references: string; components: string; referenceNames: string[] }> {
  const refPath = path.resolve('references', niche, 'README.md');
  const fallbackRefPath = path.resolve('references', 'beauty', 'README.md');
  const componentsPath = path.resolve('site-template', 'components', 'README.md');

  const chosenRef = existsSync(refPath) ? refPath : fallbackRefPath;
  const references = existsSync(chosenRef) ? await readFile(chosenRef, 'utf8') : '';
  const components = existsSync(componentsPath) ? await readFile(componentsPath, 'utf8') : '';

  // Reference headings look like "## 1. Salón Soňa — warm editorial, split hero".
  const referenceNames = [...references.matchAll(/^##\s+\d+\.\s+([^\n—-]+?)\s*[—-]/gm)]
    .map((m) => m[1]!.trim());

  return { references, components, referenceNames };
}

/**
 * The motion pack, sized for a prompt (SPEC §2.4 "референси замість смаку моделі",
 * `references/motion/README.md`).
 *
 * The art director sees the FULL index — so it may pick any of the 17 slugs — but
 * only the shortlisted references' condensed notes, because all seventeen sets of
 * notes would be ~75KB and the structured call would run out of turns writing the
 * answer. Videos are never sent: an agent cannot watch a `.webm`, and the notes
 * exist precisely to translate what the video shows into our stack.
 */
async function motionContext(business: { category?: string | null; name?: string | null }): Promise<{
  index: MotionRefIndexEntry[];
  indexText: string;
  notes: Array<{ slug: string; notes: string }>;
}> {
  const index = await loadMotionIndex();
  if (index.length === 0) {
    log.warn('motion reference pack not found; art directions will have no motion grounding');
    return { index, indexText: '', notes: [] };
  }
  const shortlist = shortlistReferences(index, business);
  const notes: Array<{ slug: string; notes: string }> = [];
  for (const entry of shortlist) {
    const condensed = await loadCondensedNotes(entry.slug);
    if (condensed) notes.push({ slug: entry.slug, notes: condensed });
  }
  return { index, indexText: renderMotionIndexForPrompt(index), notes };
}

/**
 * Additional layout references from landing.gallery (`src/lib/landingGallery.ts`).
 *
 * Fetched HERE, in stage 9, rather than in the builder, for two reasons. The art
 * director is the consumer — it is the call that decides layout and mood, and the
 * builder only implements what it decided. And the builder workspace has no
 * internet by design; downloading during stage-9 prep keeps that property intact,
 * since what reaches the workspace is ordinary files on disk.
 *
 * They land in `sites/<businessId>/gallery/`, which `prepareWorkspace` copies into
 * the build. That staging path is keyed by business rather than by project because
 * stage 9 runs before the project row (and therefore the project id) exists.
 *
 * Returns [] when the feature is off, when the endpoint is unreachable, or when
 * this business's queries match nothing — all three are ordinary outcomes, and
 * the design prompt simply loses one optional block.
 */
export function galleryStagingDir(businessId: string): string {
  return path.join(path.resolve('sites'), businessId, 'gallery');
}

async function galleryContext(snapshot: BuildSnapshot, niche: string): Promise<DownloadedRef[]> {
  if (!config.landingGallery.enabled) return [];

  const queries = buildQueries({
    category: snapshot.category,
    moodWords: snapshot.brand.mood?.words ?? null,
    // The Latin word that survives a localized business — see NICHE_QUERY_WORDS.
    niche,
  });
  // MOTION-PLAN D5: per-niche queries would hand every business in a campaign
  // the SAME few references — one inspiration set for fifty sites. Fetch a
  // wider pool and take a deterministic per-business rotation of it, so
  // neighbours see different slices while a re-run of one business still sees
  // its own slice (same input → same refs).
  const pool = await searchInspiration(queries, { limit: config.landingGallery.maxRefs * 3 });
  if (pool.length === 0) {
    log.info('landing.gallery returned nothing for this business', {
      businessId: snapshot.businessId, queries,
    });
    return [];
  }
  const seed = [...snapshot.businessId].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7);
  const offset = seed % pool.length;
  const entries = Array.from(
    { length: Math.min(config.landingGallery.maxRefs, pool.length) },
    (_, i) => pool[(offset + i) % pool.length]!,
  );
  const refs = await downloadRefs(galleryStagingDir(snapshot.businessId), entries);
  log.info('landing.gallery references fetched', {
    businessId: snapshot.businessId, queries, found: entries.length, downloaded: refs.length,
  });
  return refs;
}

/**
 * The business's measured identity, rendered for the art director.
 *
 * This is the section Roman's feedback added. Before it, the design prompt said
 * "derive the palette from something real" and then handed the model a list of
 * FILENAMES — so "something real" could only mean the reference pack, and three
 * different salons converged on the same look. Now the actual hexes are in the
 * prompt, with the evidence behind each one.
 */
function brandBlock(snapshot: BuildSnapshot): string {
  const b = snapshot.brand;
  if (b.paletteSource === 'none' && !b.voice && !b.fontsSeen && !b.mood && !b.typography) {
    return [
      'NO MEASURABLE BRAND IDENTITY.',
      'This business publishes no logo, no site colours, no usable profile picture and no bio we could',
      'read. That is a fact about the business, not a gap to paper over: you are designing an identity',
      'rather than matching one. Set `paletteSource: "reference-fallback"`, say so in `brandAlignment`,',
      'and derive the palette from the material world of this niche and this city — not from the motion',
      'reference, whose palette is another business\'s.',
    ].join('\n');
  }

  const lines: string[] = [
    b.paletteSource === 'agent'
      // The provenance line matters to how the art director should treat these
      // hexes. A measured palette is "the three biggest colours in the logo",
      // and a designer may reasonably re-rank them. An agent-led one already IS
      // a designer's reading of the whole material, so walking away from it
      // needs a real reason rather than a preference.
      ? 'Read by a designer who looked at this business\'s logo, its profile page, its site and its\n'
        + 'photographs, then re-derived in code from the exact file each colour was cited against.\n'
        + 'These are not "the dominant colours" — they are role assignments somebody made on purpose.'
      : `Measured from: ${b.paletteSource} (authority order: logo > avatar > site > photos).`,
  ];
  if (b.primary) lines.push(`PRIMARY  ${b.primary.hex}  — ${b.primary.from}`);
  if (b.accent) {
    lines.push(`ACCENT   ${b.accent.hex}  — ${b.accent.from}`);
    lines.push(`  contrast-corrected: ${b.accent.onLight} on a light ground, ${b.accent.onDark} on a dark ground.`);
    lines.push('  Use the corrected variant for text and buttons; the raw accent is the brand colour, not an');
    lines.push('  accessible one, and a demo that fails contrast in front of a business owner is a defect.');
  }
  if (b.background) lines.push(`GROUND   ${b.background.hex}  — ${b.background.from}`);
  if (b.onDark) lines.push(`GROUND (dark)  ${b.onDark.hex}  — ${b.onDark.from}`);
  const pal = (label: string, p: typeof b.logoColors) => {
    if (!p) return;
    lines.push(`${label}: ${p.colors.map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`).join('  ')}`);
    lines.push(`  ${p.from}`);
  };
  pal('LOGO   ', b.logoColors);
  pal('AVATAR ', b.avatarColors);
  pal('SITE   ', b.siteColors);
  pal('PHOTOS ', b.photoColors);
  // The three readings only a designer looking at the material can produce.
  // They are the reason the agent leads: a hex says which colour, and these say
  // what kind of thing this business is trying to be.
  if (b.typography) {
    const t = [b.typography.family, b.typography.weight, b.typography.case].filter(Boolean).join(', ');
    lines.push(`LETTERING IN THEIR OWN MATERIAL: ${t || 'no legible lettering'}`);
    if (b.typography.notes) lines.push(`  ${b.typography.notes}`);
    lines.push('  Match the CLASS, not the exact face: their wordmark being a high-contrast serif means');
    lines.push('  your display face should be one, in a family that ships the Greek subset via next/font.');
  }
  if (b.mood) {
    lines.push(`MOOD OF THEIR MATERIAL: ${b.mood.words.join(', ')}`);
    lines.push('  This is what their published material already projects. A direction that contradicts it');
    lines.push('  is redesigning the brand rather than presenting it, which is not what this demo is for.');
  }
  if (b.photographyStyle) {
    lines.push(`THEIR PHOTOGRAPHY: ${b.photographyStyle.style}`);
    lines.push('  The grade you specify has to survive THESE photographs — one treatment over all of them,');
    lines.push('  chosen for what they already look like, not for what you wish they looked like.');
  }
  if (b.fontsSeen) {
    lines.push(`TYPEFACES THE BUSINESS ITSELF USES: ${b.fontsSeen.fonts.join(', ')}`);
    lines.push('  A signal of register, NOT a list to copy — most are unavailable or fail the Greek subset.');
    lines.push('  Read them as "this business reaches for a serif / for a geometric sans" and pick accordingly.');
  }
  if (b.voice) {
    lines.push(`VOICE: ${b.voice.tone}, ${b.voice.formality}.`);
    if (b.voice.selfDescribedAs.length) lines.push(`  It describes itself as: ${b.voice.selfDescribedAs.join(' | ')}`);
    if (b.voice.statedBrandElements.length) lines.push(`  It names these brand elements: ${b.voice.statedBrandElements.join(' | ')}`);
  } else {
    lines.push('VOICE: not determinable from the captured text.');
  }
  return lines.join('\n');
}

/**
 * Palettes already deployed for OTHER businesses in this campaign.
 *
 * Roman's complaint was comparative — "чого всі демо в одному стилі" — so the
 * fix has to be comparative too. Even with per-business brand colours, three
 * salons in one city can land on the same warm-neutral answer; showing the art
 * director what the neighbours already look like is the cheapest pressure
 * against that. It is INFORMATION, not a constraint: a business whose real logo
 * is the same green as its neighbour's should still get its own green.
 */
async function siblingDesigns(campaignId: string, businessId: string): Promise<Array<{
  business: string; direction: string; referenceSlug: string | null; palette: string | null;
}>> {
  const rows = await db.select({
    name: schema.businesses.name,
    direction: schema.siteProjects.designDirection,
    designKey: schema.siteProjects.designContractKey,
  })
    .from(schema.siteProjects)
    .innerJoin(schema.businesses, eq(schema.businesses.id, schema.siteProjects.businessId))
    .where(and(
      eq(schema.businesses.campaignId, campaignId),
      ne(schema.siteProjects.businessId, businessId),
      // Any state that HAS a chosen design counts as a neighbour: a demo parked
      // in needs_human_review, or one whose build died, was still designed and
      // may still ship — excluding them made the freshest designs invisible to
      // the very next business (MOTION-PLAN D1, measured on BEAUTIFY).
      inArray(schema.siteProjects.state, ['ready', 'deployed', 'qa', 'building', 'needs_human_review', 'failed']),
    ))
    .orderBy(desc(schema.siteProjects.id))
    .limit(6);

  const out: Array<{ business: string; direction: string; referenceSlug: string | null; palette: string | null }> = [];
  for (const r of rows) {
    let referenceSlug: string | null = null;
    let palette: string | null = null;
    if (r.designKey) {
      try {
        const doc = JSON.parse((await getObject('raw', r.designKey)).toString('utf8')) as {
          chosen?: { referenceSlug?: string; palette?: Record<string, string> };
        };
        referenceSlug = doc.chosen?.referenceSlug ?? null;
        const p = doc.chosen?.palette;
        if (p) palette = `bg ${p.background} / fg ${p.foreground} / accent ${p.accent}`;
      } catch {
        // A missing or unreadable design doc is not worth failing stage 9 over;
        // the sibling simply contributes its name and direction.
      }
    }
    out.push({ business: r.name, direction: r.direction ?? '(unnamed)', referenceSlug, palette });
  }
  return out;
}

/**
 * What the whole campaign has already used, from the mirror columns — the
 * memory that outlives the 6-row siblings window (MOTION-PLAN D1/D2). Feeds
 * BOTH the art-director prompt (information) and the rubric (a deterministic
 * repeat penalty). Rows older than migration 0014 have NULL mirrors and simply
 * do not count.
 */
export interface CampaignDesignUsage {
  /** referenceSlug → how many campaign projects already use it. */
  slugCounts: Record<string, number>;
  /** Slugs of the most recent 3 designed projects — the strongest repeat signal. */
  recentSlugs: string[];
  /** Display fonts of the most recent 3 designed projects. */
  recentDisplayFonts: string[];
  /** Signatures already spent in this campaign — a signature reused is not a signature. */
  signatures: string[];
}

async function campaignDesignUsage(campaignId: string, businessId: string): Promise<CampaignDesignUsage> {
  const rows = await db.select({
    slug: schema.siteProjects.referenceSlug,
    font: schema.siteProjects.displayFont,
    signature: schema.siteProjects.signature,
  })
    .from(schema.siteProjects)
    .innerJoin(schema.businesses, eq(schema.businesses.id, schema.siteProjects.businessId))
    .where(and(
      eq(schema.businesses.campaignId, campaignId),
      ne(schema.siteProjects.businessId, businessId),
    ))
    .orderBy(desc(schema.siteProjects.id))
    .limit(100);

  const slugCounts: Record<string, number> = {};
  const recentSlugs: string[] = [];
  const recentDisplayFonts: string[] = [];
  const signatures: string[] = [];
  for (const r of rows) {
    if (r.slug) {
      slugCounts[r.slug] = (slugCounts[r.slug] ?? 0) + 1;
      if (recentSlugs.length < 3) recentSlugs.push(r.slug);
    }
    if (r.font && recentDisplayFonts.length < 3) recentDisplayFonts.push(r.font);
    if (r.signature && signatures.length < 12) signatures.push(r.signature);
  }
  return { slugCounts, recentSlugs, recentDisplayFonts, signatures };
}

/** Compact catalogue of what the design may actually reference. */
function assetInventory(snapshot: BuildSnapshot): string {
  const photos = realPhotos(snapshot);
  if (snapshot.assets.length === 0) return 'NO IMAGES AT ALL. The hero must be typographic.';
  return [
    `Real photographs (may be the hero, may depict the business):`,
    ...(photos.length
      ? photos.map((p) => `  - ${p.file} — ${p.kind}, ${p.width ?? '?'}x${p.height ?? '?'}`)
      : ['  - none']),
    `AI-generated / decorative (background or texture ONLY, never the hero subject):`,
    ...(snapshot.assets.filter((a) => a.aiGenerated).map((a) => `  - ${a.file} — ${a.kind}`) || ['  - none']),
  ].join('\n');
}

/**
 * The three stage-9 agent calls plus the context they need, split out of the
 * handler so the handler and the inspection script (`scripts/test-stage9-brand.ts`)
 * exercise ONE code path.
 *
 * The split exists because the handler ends by enqueueing `build-site`: running it
 * just to look at a design contract would start a 40-minute builder session in
 * whichever container is listening. Verifying the brand grounding must not cost a
 * build, and a second copy of the prompts would drift from the real one.
 *
 * Pure with respect to pipeline state: it reads the DB and calls agents, and
 * writes nothing.
 */
export async function runStage9Calls(
  businessId: string,
  snapshot: BuildSnapshot,
  /** Why the previous stage-9 attempt was rejected by the design gate, if it was. */
  retryFeedback?: string,
): Promise<{
  brief: ContentBrief;
  directions: { directions: ArtDirection[] };
  critique: { scores: DirectionScore[] };
  siblings: Awaited<ReturnType<typeof siblingDesigns>>;
  usage: CampaignDesignUsage;
  motionSlugs: string[];
}> {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, biz.campaignId));
  const niche = campaign?.niche ?? 'beauty';
  const contact = primaryContact(snapshot);
  const isGreek = snapshot.language.toLowerCase().startsWith('el');

  // ── 1. Content brief ──────────────────────────────────────────────────────
  await logStage(buildLogPath(businessId), 'Дизайн-етап почався: пишу контент-бриф зі снапшота', 'content-design');
  const brief = await runAgent(
    'content-brief',
    `You write the content brief for a private demo website for a real local business.

THE SNAPSHOT IS THE ONLY SOURCE OF TRUTH. It is an evidence package: every entry
carries the source ids that prove it. You may not use general knowledge about this
kind of business, plausible inference, or what similar businesses usually offer.

Rules:
- Every entry in \`allowedClaims\` must cite a real \`snapshotPath\` and copy the
  \`sourceIds\` from that snapshot entry verbatim. If you cannot point at the data,
  it is not an allowed claim — put it in \`forbiddenClaims\` instead.
- If there are no verified reviews, there is no reviews section. If there are fewer
  than three services, do not pad the list. Missing evidence produces \`omissions\`,
  never invention. A short honest page beats a long invented one.
- \`primaryCta.href\` MUST be a real contact from the snapshot: \`tel:\`, \`mailto:\`,
  or a URL the snapshot contains. Never "#", never a contact form (the site is a
  static export with no backend).
- All copy-facing strings (section names, one-liner, offer, CTA label, tone) are in
  ${snapshot.languageName}. Structural fields (ids, paths) stay in English.
- \`bannedPhrases\` should list the marketing clichés you would otherwise be tempted
  to write for THIS business, in ${snapshot.languageName}.`,
    JSON.stringify({
      snapshot,
      primaryContactSuggestion: contact,
      note: 'Sections must be justified by the evidence actually present above.',
    }, null, 2),
    ContentBriefSchema,
    {
      kind: 'content', timeoutMs: 12 * 60_000,
      onUsage: (u) => log.info('agent usage', { businessId, call: 'content-brief', ...u }),
    },
  );
  log.info('content brief ready', {
    businessId, sections: brief.sections.length, claims: brief.allowedClaims.length,
    omissions: brief.omissions.length,
  });
  await logStage(
    buildLogPath(businessId),
    `Бриф готовий: ${brief.sections.length} секцій, ${brief.allowedClaims.length} підтверджених фактів`,
    'content-design',
  );

  // ── 2. Three structurally different art directions ────────────────────────
  const { references, components, referenceNames } = await designContext(niche);
  const motion = await motionContext({ category: snapshot.category, name: snapshot.name });
  const galleryRefs = await galleryContext(snapshot, niche);
  const siblings = await siblingDesigns(biz.campaignId, businessId);
  const usage = await campaignDesignUsage(biz.campaignId, businessId);
  const brandText = brandBlock(snapshot);
  log.info('brand context for design', {
    businessId,
    paletteSource: snapshot.brand.paletteSource,
    primary: snapshot.brand.primary?.hex ?? null,
    accent: snapshot.brand.accent?.hex ?? null,
    voice: snapshot.brand.voice?.tone ?? null,
    siblings: siblings.length,
  });
  const hasRealPhoto = snapshot.assets.some((a) => !a.aiGenerated);
  const hasClip = snapshot.assets.some((a) => /\.(mp4|webm|mov)$/i.test(a.file));

  const fontRule = isGreek
    ? `THE SITE IS IN GREEK. next/font fails the build hard when a font lacks the \`greek\` subset
("Unknown subset \`greek\` for font X"). You MUST pick:
  displayFont from: ${GREEK_SAFE_DISPLAY.join(', ')}
  bodyFont from:    ${GREEK_SAFE_BODY.join(', ')}
Use these exact next/font import names (underscores, not spaces). Anything else is vetoed by code.
${GREEK_UNSAFE_NOTE}
Weight/style caveats that constrain the design, not just the build:
  - GFS_Didot is weight 400 ONLY and has NO italic. Do not plan a roman/italic couplet,
    a bold headline or weight-based hierarchy with it — get contrast from SIZE.
  - Manrope has no italic either. If the direction needs italic body copy, pick a body face
    from the list that has one (Source_Sans_3, IBM_Plex_Sans, Inter_Tight, Noto_Sans, Open_Sans).
  - EB_Garamond, Literata, Noto_Serif_Display, Alegreya and Gentium_Book_Plus all have true italics.`
    : `Pick a distinctive pair. Inter, Poppins, Montserrat, Roboto and Open Sans as the DISPLAY
face are on the anti-slop ban-list and are vetoed by code.`;

  await logStage(
    buildLogPath(businessId),
    `Арт-директор малює 3 структурно різні напрямки${galleryRefs.length ? ` (референсів з галереї: ${galleryRefs.length})` : ''}`,
    'content-design',
  );

  // The art director SEES the material it designs with. Before this it worked
  // from a list of FILENAMES and wrote photo-content claims from imagination —
  // the first shipped heroVideoBrief described «forearm skin with handpiece»
  // for a photo nobody had opened, while the card offered a vertical text
  // banner as the start frame (Roman, 2026-08-22: «І шо це за брєд?»).
  const photoDir = await createAgentInputWorkspace('factory-design-');
  const photoPaths: string[] = [];
  for (const asset of realPhotos(snapshot).slice(0, 6)) {
    try {
      const f = path.join(photoDir, path.basename(asset.file));
      await writeFile(f, await getObject('assets', asset.objectKey));
      photoPaths.push(f);
    } catch (err) {
      log.warn('photo unavailable for the design call', {
        businessId, objectKey: asset.objectKey, err: String(err).slice(0, 120),
      });
    }
  }
  for (const ref of galleryRefs) {
    // The gallery layouts too: full pages beat their index.md descriptions.
    const staged = path.join(galleryStagingDir(businessId), path.basename(ref.fullFile ?? ref.file));
    if (existsSync(staged)) photoPaths.push(staged);
  }

  const directions = await runAgent(
    'design-directions',
    `You are an art director producing THREE structurally different directions for a demo site.
${retryFeedback ? `
A PREVIOUS attempt at these directions was REJECTED by the deterministic design gate.
The reasons, verbatim — do not repeat these failures:
${retryFeedback}
` : ''}
"Structurally different" means different LAYOUT ARCHITECTURE — not three palettes of the same
page. Different hero device, different section rhythm, different relationship between type and
image. If two directions could be swapped by editing CSS variables, you have failed.

CALIBRATION — the three looks AI design defaults to, regardless of subject:
(1) warm cream background (~#F4F1EA), high-contrast serif display, terracotta accent;
(2) near-black with a single acid-green or vermilion accent;
(3) broadsheet: hairline rules, zero border-radius, dense newspaper columns.
These are defaults, not choices. A direction may land on one ONLY when the business's own
measured identity genuinely leads there — and must say so in \`derivedFrom\`. The test for
every direction: would you produce roughly this for any other business in this category and
city? If yes, it is a template wearing this business's colours — replace it before submitting.

THE SIGNATURE. Each direction fills \`signature\`: the ONE element this page will be remembered
by — what it is, which section it lives in, and why it is native to THIS business's world (its
materials, tools, rituals, place — not to web design). Spend the direction's boldness there and
keep everything else quiet; scattered effects are how pages read as AI-generated.

THE SCENE MAP. Each direction fills \`sceneMap\` — the page's choreography as a CONTRACT, not a
vibe. \`system\` is one line naming the easing family, the duration scale and what unifies every
motion. \`scenes\` has one entry per layout section that moves: its trigger (load / enter /
scrub / pin), what transforms (one line), and how it hands off to the next section (one line).
Build it FROM the chosen reference's notes — they describe real scenes; translate, don't
invent. A real motion site is scroll NARRATIVE: at least one scrub or pin scene unless the
direction argues otherwise. Sections you leave out are deliberately static — that is a valid
choice, stated by omission. Keep every field to ONE line; this map is verified frame-by-frame
by the critic, and every scene you promise will be judged.

THE HERO VIDEO BRIEF. Each direction fills \`heroVideoBrief\` and \`heroVideoStartFrame\`.
You have the business's REAL photographs attached to this call — you have seen them; their
file names match the asset inventory. Pick the one photo that best serves this direction as a
video start frame (\`heroVideoStartFrame\` = its exact file from the inventory; it must be a
real photo, not an AI image and not a text/banner graphic — code vetoes both) and write the
complete image-to-video prompt (in English): 8s landscape, camera movement / light / pace that
serve this direction's mood, hero treatment and signature, describing ONLY what is actually in
that photo. Always include the standing rule: nothing in the frame may be added, removed or
morphed. Both fields are null ONLY when no real photograph exists.

Ground rules:
- Each direction names EXACTLY ONE reference from the reference pack, by its exact name, and
  lists the concrete mechanics it borrows. Available: ${referenceNames.join(', ') || '(see pack)'}.
  Do not average multiple references — averaging premium references produces generic output.
- ONE accent colour. Three or more accents is slop.

## START FROM THE BUSINESS'S OWN IDENTITY — this is not optional

Every demo this factory produced before now came out in the same style, and the owner rejected
the batch for exactly that: "Чого всі демо в одному стилі? … Береш їхні кольори, айдентику?"
The cause was structural. The palette had nothing real to start from, so it started from the
reference pack — and a shared reference pack makes every business look like the same business.

\`brandIdentity\` is MEASURED, not suggested. Those hexes were decoded from this business's
own logo, its Instagram avatar, the colours its own stylesheet declares, or its photographs —
each one traceable to a captured source. Here it is:

${brandText}

**The rules:**

1. **The palette is derived from \`brandIdentity\`** whenever it carries colours. The brand
   primary and accent are your starting point; build the background, foreground and tint scale
   AROUND them. You may correct for contrast, darken, lighten, desaturate and build tints —
   that is craft. You may not ignore them and pick a palette you like better.
2. \`palette.paletteSource\` states which evidence you actually used:
   - \`brand\` — the palette starts from the measured brand colours. **CODE CHECKS THIS.** If
     none of your background/foreground/accent is within reach of a measured colour, the claim
     is vetoed. Do not write "brand" and then design something else.
   - \`photos\` — no logo/site/avatar colour existed, so the photograph palette carries it.
   - \`reference-fallback\` — nothing measurable at all. Honest, and allowed, but it costs
     points when brand evidence WAS available.
3. \`palette.brandAlignment\` says, concretely, which brand hex became which role, or why a
   measured colour could not be used ("the logo's #c8a15a fails contrast on every ground the
   photographs allow, so it is used only for rules and micro-labels").
4. **The reference contributes MECHANICS, NOT COLOUR.** Motion, scroll choreography, section
   rhythm, type scale, crop language — take all of that. Its palette belongs to a different
   business in a different city, and borrowing it is precisely how these demos became
   interchangeable. Never set a colour because the reference uses it.
5. **The voice matches.** If \`brandIdentity.voice\` says playful/casual, a severe luxury
   monochrome contradicts the business's own words; if it says clinical/formal, a hand-drawn
   warm treatment does. Where voice is null, the category and the photographs decide.
6. \`derivedFrom\` stays as it was: one line naming what in the world the palette comes from.
- ${fontRule}
- Motion must reveal content, not decorate it. Maximum 4 techniques, and a real reduced-motion plan.

## THE MOTION PACK — this is what "wow" means here

A demo whose first screen does not move was rejected outright. Every direction must be
grounded in the motion reference pack (17 award-winning sites captured as scroll-through
video; the notes below translate their mechanics into our stack).

- \`referenceSlug\`: EXACTLY ONE slug from the index below. Not a name, not two averaged —
  averaging premium references is itself a reliable route to generic output. A slug that is
  not in the index is vetoed by code.
- \`mechanics\`: 3-4 CONCRETE mechanics taken from that reference's notes (\`motionNotes\`
  below, when its notes were shipped). Name each one as the notes name it, map it to the
  component that implements it, and say which section it lands in. Three or four maximum —
  every reference lists five or six, and taking all of them produces a showreel, not a
  business page.
  Motion components available in the template: ${MOTION_COMPONENTS.join(', ')}. Anything else
  is \`css\` or \`gsap\` (hand-written) or a name from the component pool catalogue.
- \`heroMotion\`: one of ${HERO_MOTION_KINDS.join(' | ')}.
  ${hasClip ? '' : 'There is NO video asset for this business, so `video` is vetoed by code. '}${hasRealPhoto
    ? '`kenburns` over a real photo is the reliable default; `mask` and `split` are scroll-linked reveals over a real photo.'
    : 'There is NO real (non-AI) photo, so `kenburns`, `mask` and `split` are all vetoed by code — a typographic hero with `none` plus a justification is the honest choice here.'}
  \`none\` requires \`heroMotionJustification\`; a static first screen scores 0 on the hero-motion
  axis and the visual critic fails it outright.
- \`preloader\`: a typographic load screen (headline + counter) capped at ~1.2s, dismissed on
  \`window.load\` and skipped under reduced motion. Eight of the seventeen references use one.
  Their versions run for several seconds — that reads as a broken site on a cold demo over 4G,
  so ours is capped. Set false if the direction does not want one.
- \`typeAsDesign\`: one sentence on how TYPE itself does design work — display size above 8vw,
  a ~10:1 size ratio to body, a cropped/overflowing wordmark, or roman/italic mixing.
- \`photoGrade\`: one named grade applied to EVERY photo (${PHOTO_GRADES.join(', ')}), which is
  what makes mixed-quality client photos read as one shoot. null only when there are no photos.

You are scored on these six wow axes (0-3 each, ${WOW_MAX} total). ${renderWowGate()}

${renderWowRubric()}

Performance budget: the mechanics must survive a static export on a mid-range phone. No WebGL,
no three.js. Every animation must have a reduced-motion branch that leaves the page complete.

### Motion reference index (pick ONE slug)

${motion.indexText || '(motion pack unavailable — fall back to the niche reference pack below)'}

${renderGalleryBlock(galleryRefs)}
- \`poolComponents\`: at most 4, by their exact names from the component catalogue. Fewer is better —
  a page stacking Aurora + Lamp + Beams + Marquee looks like a component demo, not a business.
- \`heroTreatment.assetFile\` must be a file that exists in the asset inventory, or null. A
  \`real-photo-*\` hero REQUIRES a real (non-AI) photo. AI images are decoration only.
- Sections in \`layoutSkeleton\` use the section ids from the content brief. Vary \`heightFeel\`
  deliberately: equal-height sections in sequence are what makes a page feel machine-generated.

${siblings.length ? `## Demos this factory has ALREADY built in this campaign

These are real pages a neighbouring business in the same city and niche has already been shown.
Your directions must not be mistakable for them. This is the comparative half of the problem:
per-business colours are not enough if three salons all land on the same warm-neutral answer.

${siblings.map((sb) => `- **${sb.business}** — direction "${sb.direction}"${sb.referenceSlug ? `, motion reference \`${sb.referenceSlug}\`` : ''}${sb.palette ? `, palette ${sb.palette}` : ''}`).join('\n')}

Differentiate on SUBSTANCE, not on decoration: a different structural architecture, a different
hero device, a different type register — and above all this business's OWN colours rather than
the campaign's house style. If a sibling used a motion reference, prefer a different one unless
this business's material genuinely calls for the same mechanics.

Note what this is NOT: a ban on a colour family. If this business's real logo happens to be the
same green as its neighbour's, it still gets its green — the evidence outranks the variety
pressure, and saying so in \`brandAlignment\` is the right answer.` : ''}

${Object.keys(usage.slugCounts).length || usage.signatures.length ? `## What this campaign has ALREADY used (all designed demos, not just the recent ones)

Motion references: ${Object.entries(usage.slugCounts).sort((a, b) => b[1] - a[1])
  .map(([slug, n]) => `\`${slug}\`×${n}`).join(', ') || '(none yet)'}.
Recent display fonts: ${usage.recentDisplayFonts.join(', ') || '(none)'}.
Signatures already spent: ${usage.signatures.length ? usage.signatures.map((sg) => `«${sg.slice(0, 90)}»`).join('; ') : '(none)'}.

The rubric applies a DETERMINISTIC repeat penalty for reusing a recent neighbour's motion
reference or display pair — prefer slugs and pairs this campaign has not leaned on, unless this
business's material genuinely calls for a used one (say so in the direction). A SIGNATURE that
repeats one above is not a signature at all: fifty pages each remembered for the same element
are remembered for nothing.` : ''}

ANTI-SLOP BAN-LIST (these are QA failures): purple/violet-to-blue gradients, gradient text on
headlines, a row of three identical cards, emoji as bullets or icons, centred-H1-plus-two-buttons
heroes, every section a full-width band with a centred title, autoplaying carousels, bouncing
arrows, everything animating on entrance at once.`,
    JSON.stringify({
      business: { name: snapshot.name, category: snapshot.category, city: snapshot.city, language: snapshot.languageName },
      brief,
      /**
       * The measured identity, as structured data next to the rendered block in
       * the system prompt. The prose tells the art director what to DO with it;
       * this is what it reads the hexes out of.
       */
      brandIdentity: snapshot.brand,
      assetInventory: assetInventory(snapshot),
      /**
       * Condensed to "what makes the wow" + "reproduce with our stack" +
       * "don't borrow" — the mechanics and how to build them, without the
       * timing/palette/mobile prose. ~4-6KB each instead of 7-15KB.
       */
      motionNotes: motion.notes,
      motionNotesNote: motion.notes.length
        ? `Notes shipped for ${motion.notes.map((n) => n.slug).join(', ')} (the closest matches). You may still choose any slug from the index; if you pick one without notes here, borrow only the mechanics the index line names.`
        : 'No motion notes available.',
      // Trimmed to make room for the motion notes: this pack now covers
      // composition/palette/typography, the motion pack covers what the page DOES.
      referencePack: references.slice(0, 14_000),
      componentCatalogue: components.slice(0, 16_000),
    }, null, 2),
    ArtDirectionsSchema,
    {
      kind: 'design', heavy: true, timeoutMs: 15 * 60_000,
      // Three full art directions against the whole reference pack is the biggest
      // structured output in the pipeline; give it room rather than trimming the
      // references decision #11 says should ground it. Extra turns cover the
      // image Reads: the photos and gallery pages attached below are the
      // grounding for photoTreatment, the signature and the video brief.
      maxTurns: 3 + Math.min(photoPaths.length, 10),
      imagePaths: photoPaths,
      onUsage: (u) => log.info('agent usage', { businessId, call: 'design-directions', ...u }),
    },
  );
  await rm(photoDir, { recursive: true, force: true }).catch(() => {});
  await logStage(
    buildLogPath(businessId),
    `Напрямки готові: ${directions.directions.map((d) => `«${d.name}»`).join(', ')} — критик оцінює`,
    'content-design',
  );
  log.info('art directions ready', {
    businessId, names: directions.directions.map((d) => d.name),
  });

  // ── 3. Independent critique — scores only; the choice is made by code ─────
  const critique = await runAgent(
    'design-critique',
    `You are an independent design critic. You did NOT create these directions.

Score each one on every axis, 0-10 integers. You are NOT choosing a winner — a deterministic
rubric in code does that from your numbers. Your job is to make the numbers honest and to name
the slop tells you can see, so a bad direction cannot win by being described confidently.

Axes:
- structuralDistinctiveness: how far the LAYOUT is from a generic template. Three-cards-and-a-hero = 2.
- evidenceFit: does the plan match the assets and facts that actually exist? A photo-led hero with
  no usable photograph scores 0-2; a plan that turns scarce assets into an aesthetic scores high.
- typographicCraft: extreme size contrast, few styles, uppercase letterspaced micro-labels, restraint.
- referenceGrounding: how concretely the named reference's mechanics are borrowed. Vague homage = low.
- motionRestraint: motion that reveals content scores high; decoration, autoplay and entrance-everything score low.
- brandFit: does the palette actually start from the business's OWN measured identity, and is
  this page distinguishable from the ones already built for its neighbours?
  \`brandIdentity\` below carries the colours decoded from this business's logo / avatar /
  stylesheet / photographs. Score:
    * 8-10 — the palette is visibly built from the measured colours (corrected, tinted, extended
      into a scale is all fine) AND \`brandAlignment\` says concretely which hex became which
      role; or, where no identity was measurable, \`reference-fallback\` is declared honestly
      and the palette comes from the niche rather than from the motion reference.
    * 4-7 — gestures at the brand colours but the page would look the same without them.
    * 0-3 — a measured brand palette exists and the direction ignored it, or it claims
      \`paletteSource: "brand"\` while naming colours unrelated to any measured one, or it
      simply reuses a sibling demo's palette. **This is the specific failure the owner
      rejected the first batch for — score it honestly and low.**
  Colour taken from the MOTION REFERENCE is not brand fit; the reference supplies mechanics.
- slopRisk (HIGHER = WORSE): ban-list tells present or strongly implied. List each one in detectedSlopTells.
- buildRisk (HIGHER = WORSE): risk this cannot be built from the component pool as a static export.

WOW AXES (\`wow\`), 0-3 each, ${WOW_MAX} total. Score what the direction PROMISES — a direction
that never states a mechanic cannot score for it, and a vague "subtle scroll animations" is a 1,
not a 3. ${renderWowGate()}
Failing that gate is penalised hard by code as "default AI template", so honest low scores here
are the point:

${renderWowRubric()}

Read \`referenceSlug\`, \`mechanics\`, \`heroMotion\`, \`preloader\`, \`typeAsDesign\` and
\`photoGrade\` when scoring these. A direction with \`heroMotion: "none"\` scores 0 on
heroMotion — no exceptions, however good the justification.

\`name\` must match the direction's name exactly.`,
    JSON.stringify({
      business: { name: snapshot.name, category: snapshot.category, language: snapshot.languageName },
      assetInventory: assetInventory(snapshot),
      brandIdentity: snapshot.brand,
      siblingDemosInThisCampaign: siblings,
      directions: directions.directions,
    }, null, 2),
    DirectionCritiqueSchema,
    {
      kind: 'qa', heavy: true, timeoutMs: 12 * 60_000, maxTurns: 3,
      onUsage: (u) => log.info('agent usage', { businessId, call: 'design-critique', ...u }),
    },
  );

  return {
    brief, directions, critique, siblings,
    usage,
    motionSlugs: motion.index.map((e) => e.slug),
  };
}

export async function contentDesignHandler(payload: JobPayload): Promise<void> {
  const startedAt = Date.now();
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);

  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);
  const transitioned = await businessTransitions.normal({
    businessId,
    expectedStatus,
    to: 'site_in_progress',
    actor: 'content-design-worker',
  });
  if (!canContinueAfterTransition(transitioned, { businessId, actor: 'content-design-worker' })) {
    throw new JobSkippedError(
      `Бізнес уже не в стані «${expectedStatus}» — підготовку дизайну пропущено. Нова збірка починається кнопкою «Побудувати заново».`,
    );
  }

  const snapshot = await buildSnapshot(businessId);
  const designAttempt = (payload.designAttempt as number | undefined) ?? 1;
  const { brief, directions, critique, usage, motionSlugs } = await runStage9Calls(
    businessId, snapshot, (payload.designFeedback as string | undefined) ?? undefined,
  );

  await logStage(buildLogPath(businessId), 'Критик оцінив напрямки — рубрика обирає переможця', 'content-design');
  // ── Deterministic decision ────────────────────────────────────────────────
  const verdict = chooseDirection(
    directions.directions, critique.scores, snapshot, motionSlugs, usage,
  );
  log.info('design chosen by rubric', {
    businessId, chosen: verdict.chosen.name, score: verdict.chosenScore,
    ranking: verdict.ranking.map((r) => `${r.name}=${r.score}`),
    vetoes: verdict.ranking[0]?.vetoes.length ?? 0,
    referenceSlug: verdict.chosen.referenceSlug,
    heroMotion: verdict.chosen.heroMotion,
    wow: `${verdict.chosenWow.total}/${WOW_MAX}`,
    wowPassed: verdict.chosenWow.passed,
  });
  // ── The design gate (Roman's review, 2026-08-23): a contract that fails
  // here must NOT ride into a 40-90 minute build. The DECISION lives in
  // `routeDesignGate` (rubric.ts, unit-tested next to the vetoes it reads);
  // this worker only executes it: retry once, escalate, or build.
  const route = routeDesignGate(verdict, designAttempt);
  if (route.action === 'retry') {
    log.warn('design gate rejected the winning direction; retrying stage 9 once', {
      businessId, chosen: verdict.chosen.name, reasons: route.reasons,
    });
    await logStage(
      buildLogPath(businessId),
      `Дизайн-гейт відхилив «${verdict.chosen.name}» (${route.reasons.length} причин) — арт-директор пробує ще раз`,
      'content-design',
    );
    await enqueue('content-and-design', {
      businessId, campaignId: biz.campaignId,
      designAttempt: 2,
      designFeedback: route.reasons.map((r) => `- ${r}`).join('\n'),
      // STABLE key (Roman's review 2026-08-23): Date.now() here meant a
      // re-executed parent job could enqueue a duplicate retry. One retry per
      // business per contract version is exactly the gate's semantics.
      idempotencyKey: `content-and-design:${businessId}:gate-retry:v${DESIGN_CONTRACT_VERSION}`,
    });
    return;
  }
  if (route.action === 'needs_human') {
    // Repairable vetoes still build after the retry (the builder swaps a font
    // or drops a component, and BUILD-TASK carries them explicitly). A wow
    // floor missed twice, or an evidence/contract violation, does not — see
    // routeDesignGate for the reasoning.
    throw new NeedsHumanError(
      `Дизайн-гейт відхилив обидві спроби: ${route.reasons.join('; ')}. `
      + 'Подивись на матеріал бізнесу — можливо, бракує фото або айдентики для сильного напрямку.',
    );
  }

  // ── Freeze everything ─────────────────────────────────────────────────────
  const snapshotKey = await putRaw(`sites/${businessId}/snapshot`, JSON.stringify(snapshot, null, 2), 'application/json');
  const briefKey = await putRaw(`sites/${businessId}/brief`, JSON.stringify(brief, null, 2), 'application/json');
  const designKey = await putRaw(
    `sites/${businessId}/design`,
    JSON.stringify({
      schemaVersion: DESIGN_CONTRACT_VERSION,
      chosen: verdict.chosen,
      rubric: {
        ranking: verdict.ranking, rationale: verdict.rationale, scores: critique.scores,
        chosenWow: verdict.chosenWow,
      },
      alternatives: directions.directions.filter((d) => d.name !== verdict.chosen.name),
    }, null, 2),
    'application/json',
  );

  let projectId: number | null = null;
  await commitWorkflow(async (tx) => {
    const [project] = await tx.insert(schema.siteProjects).values({
      businessId,
      dir: '', // set by the builder once the workspace exists (it is keyed by project id)
      snapshotKey,
      contentBriefKey: briefKey,
      designContractKey: designKey,
      designDirection: verdict.chosen.name,
      // Mirrors for campaign-wide diversity aggregates (MOTION-PLAN D1/D2).
      referenceSlug: verdict.chosen.referenceSlug,
      displayFont: verdict.chosen.typography.displayFont,
      signature: verdict.chosen.signature,
      designScore: verdict.chosenScore,
      wowScores: {
        design: {
          total: verdict.chosenWow.total,
          ambition: verdict.chosenWow.ambition,
          passed: verdict.chosenWow.passed,
          reasons: verdict.chosenWow.reasons,
          axes: verdict.chosenWow.axes,
          referenceSlug: verdict.chosen.referenceSlug,
          heroMotion: verdict.chosen.heroMotion,
        },
      },
      state: 'brief',
    }).returning({ id: schema.siteProjects.id });
    if (!project) throw new Error(`failed to create site project for ${businessId}`);
    projectId = project.id;
    return [{
      name: 'build-site',
      payload: {
        businessId,
        campaignId: biz.campaignId,
        projectId: project.id,
        iteration: 0,
        idempotencyKey: `build-site:${businessId}:${project.id}:0`,
      },
    }];
  });
  if (projectId === null) throw new Error(`site project transaction returned no id for ${businessId}`);

  log.info('stage 9 complete', {
    businessId, projectId, seconds: Math.round((Date.now() - startedAt) / 1000),
  });

  // First line of this project's live build log. It can only be written here,
  // not at the top of the stage: the log is keyed by project id and the project
  // row is created a few lines above. Everything stage 9 did is summarised into
  // this one line rather than back-dated into a timeline that did not exist yet.
  await logStage(
    buildLogPath(businessId),
    `Текст і дизайн готові за ${Math.round((Date.now() - startedAt) / 60_000)} хв · `
    + `обрано напрямок «${verdict.chosen.name}» — стартує збірка сайту (проєкт ${projectId})`,
    'content-design',
  ).catch((error) => log.warn('build log write failed after stage 9 commit', {
    businessId,
    projectId,
    error: String(error),
  }));
}
