/**
 * Agent-led brand identity — a designer LOOKS at the business's material.
 *
 * WHY THIS EXISTS. `brandIdentity.ts` measures pixels: median-cut over the logo,
 * the avatar, the photographs, plus the colours declared in the site's markup.
 * That is exact, reproducible, and blind. It cannot tell that the terracotta
 * covering 40% of a photograph is a brick wall rather than a brand colour, that
 * a salon's Instagram grid is graded warm on purpose, or that a wordmark is set
 * in a high-contrast didone and therefore wants a serif on the demo. Roman's
 * decision (2026-08-21): "Айдентику і кольори має формувати агент. Sonnet 5
 * достатньо. Він нормально дослідить лого, візуал сайту, візуал сторінки інсти.
 * Агент зробить це краще."
 *
 * So the agent leads and the measurement becomes a CHECK. A code agent (not a
 * structured text call — it has to SEE) is given a workspace of real files: the
 * logo, the Instagram avatar and profile screenshot, the audit's screenshots of
 * the business's own site, and up to six of its best photographs. `Read` is the
 * only tool it has. It answers with hexes, each one naming the FILE it read the
 * colour off.
 *
 * GROUNDING (the invariant this module turns on). A hex the agent names is a
 * claim, not evidence. Every one is re-derived in code: the cited file is
 * decoded, median-cut with the same function the deterministic path uses, and
 * the claimed hex must land within `GROUNDING_TOLERANCE_RGB` of a colour that is
 * actually in that file. A hex that does not is DROPPED with a note. This is the
 * same rule as everywhere else in the factory — a fact with no source is not a
 * fact — applied to a model that can otherwise produce a beautiful palette out
 * of nothing.
 *
 * FALLBACK. Agent failure, an empty workspace, or every hex failing grounding
 * all return null, and `brandIdentity.ts` proceeds down its original
 * deterministic path unchanged. There is no state in which this module's failure
 * costs a business its palette.
 */
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { and, desc, eq, like } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getObject } from '../lib/storage.js';
import { runCodeAgent, z } from '../agents/codeAgent.js';
import { createAgentInputWorkspace } from '../agents/transport.js';
import { log } from '../lib/logger.js';
import {
  decodeImage, fromHex, newDecodePage, paletteFromImage, type PaletteEntry, type Rgb,
} from './colorExtract.js';

// ── the contract with the agent ─────────────────────────────────────────────

/**
 * One input file, as the agent sees it and as the grounding check resolves it.
 * `sourceId` is the capture that proves the file exists; it becomes the
 * `source_id` of every fact derived from that file.
 */
export interface BrandInput {
  /** Filename inside the workspace, e.g. `logo.png`. What the agent cites. */
  file: string;
  /** What it is, in the words INPUTS.md uses. */
  what: string;
  /** business_sources.id of the capture this file came from. */
  sourceId: number;
  /** Bucket + key, so the grounding check can re-read the exact bytes. */
  bucket: 'raw' | 'assets';
  objectKey: string;
  contentType: string;
}

const PaletteRoleSchema = z.object({
  hex: z.string(),
  /** The workspace FILE this colour was read off. Must match an INPUTS.md row. */
  file: z.string(),
  /** One sentence: where in that file, and why it is the brand's. */
  why: z.string(),
});

export const BrandAgentResultSchema = z.object({
  palette: z.object({
    primary: PaletteRoleSchema.nullable(),
    accent: PaletteRoleSchema.nullable(),
    background: PaletteRoleSchema.nullable(),
    /** Optional: the background to use when the design goes dark. */
    onDark: PaletteRoleSchema.nullable(),
  }),
  typography: z.object({
    /** serif | sans | slab | script | display | mixed */
    family: z.string().nullable(),
    /** light | regular | medium | bold | black */
    weight: z.string().nullable(),
    /** uppercase | title | lowercase | mixed */
    case: z.string().nullable(),
    /** Which file(s) this reading comes from. */
    files: z.array(z.string()).max(6),
    notes: z.string(),
  }),
  /** 2-5 words for the register the MATERIAL projects. */
  mood: z.array(z.string()).max(6),
  /** How the business's own photography looks, or why it cannot be judged. */
  photographyStyle: z.string().nullable(),
  /** The register of its own words, when the material carries any. */
  voice: z.object({
    tone: z.string().nullable(),
    formality: z.enum(['formal', 'neutral', 'casual']).nullable(),
    notes: z.string(),
  }),
  /** 0-1. Low is a CORRECT answer for generic material. */
  confidence: z.number().min(0).max(1),
  /** Anything the agent wants on the record, including "this material is generic". */
  notes: z.array(z.string()).max(10),
});

export type BrandAgentResult = z.infer<typeof BrandAgentResultSchema>;

const BRAND_AGENT_PROMPT = `You are a brand designer doing the first hour of work on a new client: looking at
everything the business has already published and naming the identity that is ALREADY there.

Read INPUTS.md first. It lists every file in this workspace and says what each one is. Then Read
every image file it names. You have no other tools and no other knowledge of this business —
whatever is not in these files does not exist for you.

WHAT YOU ARE ANSWERING

1. PALETTE. \`primary\`, \`accent\`, \`background\`, and optionally \`onDark\`.
   - Every hex must be a colour YOU CAN SEE in the file you cite. Not a colour you would
     recommend, not a tasteful neighbour of it — the actual colour, as it appears.
   - \`file\` must be one of the filenames from INPUTS.md, exactly as written there.
   - CODE RE-DERIVES EVERY HEX from the file you cite and drops any that is not really in it.
     A dropped hex is worse than a missing one: it costs the business a palette role. So cite
     the file you actually read the colour off, and read it generously — sample the large flat
     areas, not a single antialiased edge pixel.
   - Authority: a logo is a decision somebody paid for; an avatar is the logo of a business that
     has no logo file; a website's own colours are a design system; photographs are a room
     somebody stood in. Prefer in that order, but say what you see: if the logo is a black
     wordmark on white and all the real colour is in the photographs, say that.
   - \`background\` is the page ground the identity implies (usually a near-neutral off-white or
     a deep near-black), NOT the third most common colour.

2. TYPOGRAPHY. What the material's own lettering is doing — is the wordmark a serif or a sans,
   heavy or light, set uppercase or title case? If the only lettering is a stock Instagram UI
   font, say so and answer null rather than inventing a preference.

3. MOOD. Two to five words for the register the MATERIAL projects: e.g. "warm", "clinical",
   "editorial", "street", "opulent", "utilitarian". Judge the images, not the business type.

4. PHOTOGRAPHY STYLE. How this business's own photographs look — lighting, grade, crop,
   whether people are in them, whether they are phone snapshots or shot work. If there are no
   real photographs in the workspace, answer null.

5. VOICE. Only if the material carries the business's own words (a bio in a screenshot, copy on
   the site). Otherwise null.

ABSOLUTE RULES

- NEVER invent. If the material is generic — a stock template site, three blurry phone photos,
  a default avatar — the correct answer is low \`confidence\`, nulls where you cannot see an
  answer, and a note saying the material is generic. An honest "this business has no visual
  identity we can measure" is a useful finding. A confident invented palette is a defect that
  ships to a real business owner.
- Cite files by their exact INPUTS.md filename. A citation that names no file is dropped.
- Do not describe the business, write copy, or suggest a redesign. You are naming what exists.`;

// ── grounding ───────────────────────────────────────────────────────────────

/**
 * How far a claimed hex may sit from a colour actually present in the cited
 * file, as Euclidean distance in RGB.
 *
 * 60 units, the same figure `paletteEchoesBrand` uses for the design contract
 * (`src/build/rubric.ts`) and for the same reason: it is roughly "a designer
 * would call these the same colour". A tighter bound would fail honest answers —
 * the agent reads a colour by eye off a downscaled render while the check
 * re-derives it from median-cut centroids, and those two never agree to the
 * byte. A looser one would let "warm beige" pass against a photograph of a room,
 * which is the invention this check exists to catch.
 */
export const GROUNDING_TOLERANCE_RGB = 60;

/** Colours genuinely present in one file, as the grounding check sees them. */
export interface FileColors {
  file: string;
  palette: PaletteEntry[];
}

export interface GroundingVerdict {
  grounded: boolean;
  /** The nearest real colour in the cited file, when there is one. */
  nearestHex: string | null;
  distance: number | null;
  reason: string | null;
}

/**
 * Is this hex really in that file?
 *
 * Three ways to fail, and they are distinguished because the fix differs: a
 * malformed hex is an agent bug, an unknown file is a citation that names
 * nothing, and a real-but-distant colour is the invention case.
 */
export function checkGrounding(
  claim: { hex: string; file: string },
  files: readonly FileColors[],
  tolerance = GROUNDING_TOLERANCE_RGB,
): GroundingVerdict {
  const rgb = fromHex(claim.hex);
  if (!rgb) {
    return { grounded: false, nearestHex: null, distance: null, reason: `"${claim.hex}" is not a hex colour` };
  }
  // Filenames are compared on the basename: the agent sometimes cites
  // `./logo.png` or a path relative to the workspace, and rejecting a correct
  // citation over a leading dot would drop a grounded colour.
  const wanted = path.basename(claim.file.trim()).toLowerCase();
  const hit = files.find((f) => path.basename(f.file).toLowerCase() === wanted);
  if (!hit) {
    return {
      grounded: false, nearestHex: null, distance: null,
      reason: `cites "${claim.file}", which is not a file in the workspace`,
    };
  }
  if (hit.palette.length === 0) {
    return {
      grounded: false, nearestHex: null, distance: null,
      reason: `"${hit.file}" yielded no colours to compare against`,
    };
  }

  let nearest: { hex: string; d: number } | null = null;
  for (const c of hit.palette) {
    const other = fromHex(c.hex);
    if (!other) continue;
    const d = rgbDistance(rgb, other);
    if (!nearest || d < nearest.d) nearest = { hex: c.hex, d };
  }
  if (!nearest) {
    return {
      grounded: false, nearestHex: null, distance: null,
      reason: `"${hit.file}" yielded no comparable colours`,
    };
  }
  const distance = Number(nearest.d.toFixed(1));
  if (nearest.d <= tolerance) {
    return { grounded: true, nearestHex: nearest.hex, distance, reason: null };
  }
  return {
    grounded: false,
    nearestHex: nearest.hex,
    distance,
    reason: `${claim.hex} is ${distance} RGB units from the nearest colour actually in `
      + `${hit.file} (${nearest.hex}); tolerance is ${tolerance}`,
  };
}

export function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/**
 * The `source_id` behind a cited file, or null when the citation names nothing.
 *
 * This is the INPUTS.md mapping in code: the agent cites a filename, and every
 * fact derived from it must carry the id of the capture that produced it. Same
 * basename normalisation as `checkGrounding`, so a citation cannot ground
 * against a file and then fail to find its source.
 */
export function sourceIdForFile(file: string, inputs: readonly BrandInput[]): number | null {
  const wanted = path.basename(file.trim()).toLowerCase();
  const hit = inputs.find((i) => path.basename(i.file).toLowerCase() === wanted);
  return hit ? hit.sourceId : null;
}

// ── workspace assembly ──────────────────────────────────────────────────────

/** Extension for a stored object, so the agent's Read sees a real image file. */
function extFor(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  if (t.includes('svg')) return 'svg';
  if (t.includes('avif')) return 'avif';
  return 'jpg';
}

/**
 * Everything this business has published that a designer could look at.
 *
 * Ordered by authority, because the workspace is also the agent's reading order
 * and a cap on the photo count has to bite on the least important material
 * first: logo, social avatar + profile screenshot, the business's own site as
 * rendered, then its best photographs.
 *
 * Reads only from storage and the DB — no network, no new captures. A business
 * that was enriched before this module existed still has all of this, which is
 * what makes `refresh-brand` able to run over the whole back catalogue.
 */
export async function collectBrandInputs(
  businessId: string,
  opts: { maxPhotos?: number } = {},
): Promise<BrandInput[]> {
  const inputs: BrandInput[] = [];

  const sourceRows = await db.select().from(schema.businessSources)
    .where(eq(schema.businessSources.businessId, businessId));
  const assetRows = await db.select().from(schema.assets)
    .where(eq(schema.assets.businessId, businessId));
  const siteSource = sourceRows
    .filter((r) => r.sourceType === 'owned_website')
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0] ?? null;
  const gosomSource = sourceRows.find((r) => r.sourceType === 'google_maps') ?? null;

  // ── 1. the logo ──────────────────────────────────────────────────────────
  const logo = assetRows.find((a) => a.intendedUsage === 'logo' && !a.aiGenerated);
  if (logo) {
    const sourceId = (logo.sourceType === 'owned_website' ? siteSource?.id : gosomSource?.id)
      ?? siteSource?.id ?? gosomSource?.id ?? null;
    if (sourceId) {
      inputs.push({
        file: `logo.${extFor(logo.contentType ?? 'image/png')}`,
        what: `The business's own logo, collected from ${logo.sourceUrl}`,
        sourceId, bucket: 'assets', objectKey: logo.objectKey,
        contentType: logo.contentType ?? 'image/png',
      });
    }
  }

  // ── 2. social profile: the rendered page, then the avatar ────────────────
  //
  // The screenshot is `social_screenshot.*`, written by `socialDiscovery.ts`
  // while the profile was open. A business enriched before that existed has no
  // row, and simply contributes no screenshot.
  const shotFacts = await db.select().from(schema.businessFacts).where(and(
    eq(schema.businessFacts.businessId, businessId),
    like(schema.businessFacts.key, 'social_screenshot.%'),
  )).orderBy(desc(schema.businessFacts.capturedAt));
  const seenPlatforms = new Set<string>();
  for (const f of shotFacts) {
    const platform = f.key.split('.')[1] ?? 'social';
    if (seenPlatforms.has(platform)) continue;   // newest per platform only
    const v = f.value && typeof f.value === 'object' ? f.value as Record<string, unknown> : null;
    const key = typeof v?.objectKey === 'string' ? v.objectKey : null;
    if (!key || !f.sourceId) continue;
    seenPlatforms.add(platform);
    inputs.push({
      file: `${platform}-profile.png`,
      what: `Screenshot of the business's ${platform} profile page as it renders (${String(v?.url ?? '')})`,
      sourceId: f.sourceId, bucket: 'raw', objectKey: key, contentType: 'image/png',
    });
  }

  // The avatar is stored as an asset when the logo hunter picked it up; there is
  // no separate download here, because a module that re-fetches a CDN URL on
  // every refresh is a module that eventually reads somebody else's picture.
  const avatar = assetRows.find((a) => !a.aiGenerated
    && /avatar|profile[-_]?pic/i.test(`${a.sourceUrl} ${a.objectKey}`));
  if (avatar && avatar.objectKey !== logo?.objectKey) {
    const sourceId = siteSource?.id ?? gosomSource?.id ?? null;
    if (sourceId) {
      inputs.push({
        file: `avatar.${extFor(avatar.contentType ?? 'image/jpeg')}`,
        what: `The business's social profile picture, from ${avatar.sourceUrl}`,
        sourceId, bucket: 'assets', objectKey: avatar.objectKey,
        contentType: avatar.contentType ?? 'image/jpeg',
      });
    }
  }

  // ── 3. the business's own site, as the audit rendered it ─────────────────
  const [audit] = await db.select().from(schema.websiteAudits)
    .where(eq(schema.websiteAudits.businessId, businessId))
    .orderBy(desc(schema.websiteAudits.auditedAt)).limit(1);
  if (audit && siteSource) {
    for (const [key, file, what] of [
      [audit.desktopScreenshotKey, 'site-desktop.png', "The business's own website, desktop viewport"],
      [audit.desktopFullScreenshotKey, 'site-desktop-full.png', "The business's own website, full page"],
    ] as const) {
      if (!key) continue;
      inputs.push({
        file, what: `${what} (${audit.bestEndpoint ?? siteSource.url})`,
        sourceId: siteSource.id, bucket: 'raw', objectKey: key, contentType: 'image/png',
      });
    }
  }

  // ── 4. its best photographs ──────────────────────────────────────────────
  const photos = assetRows
    .filter((a) => !a.aiGenerated
      && (a.contentType ?? '').startsWith('image/')
      && a.intendedUsage !== 'logo'
      && a.objectKey !== avatar?.objectKey)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))
    .slice(0, opts.maxPhotos ?? 6);
  const photoSourceId = gosomSource?.id ?? siteSource?.id ?? null;
  if (photoSourceId) {
    photos.forEach((p, n) => {
      inputs.push({
        file: `photo-${n + 1}.${extFor(p.contentType ?? 'image/jpeg')}`,
        what: `A photograph the business published (${p.intendedUsage}, ${p.width ?? '?'}x${p.height ?? '?'}), from ${p.sourceUrl}`,
        sourceId: photoSourceId, bucket: 'assets', objectKey: p.objectKey,
        contentType: p.contentType ?? 'image/jpeg',
      });
    });
  }

  return inputs;
}

/**
 * The file the agent reads first: every input by name, with what it is.
 *
 * Source ids are deliberately NOT in here. The agent's job is to look at
 * pictures and cite filenames; the filename → source_id mapping is code's
 * (`sourceIdForFile`), and putting ids in the prompt would invite the model to
 * quote one it never derived anything from.
 */
export function renderInputsMd(businessName: string, inputs: readonly BrandInput[]): string {
  return [
    `# Brand material for ${businessName}`,
    '',
    'Every file below was published by this business and captured as evidence. There is nothing',
    'else. Read each one before answering, and cite files by the exact names in this list.',
    '',
    ...inputs.map((i) => `- \`${i.file}\` — ${i.what}`),
    '',
    'When you cite a colour, name the file you read it off. Code re-derives every hex from the',
    'file you cite and drops the ones that are not really there.',
  ].join('\n');
}

// ── the run ─────────────────────────────────────────────────────────────────

/** One palette role after grounding: kept with its evidence, or dropped with a reason. */
export interface GroundedRole {
  role: 'primary' | 'accent' | 'background' | 'onDark';
  hex: string;
  file: string;
  why: string;
  sourceId: number;
}

export interface BrandAgentOutcome {
  /** What survived grounding. Empty when the agent produced nothing usable. */
  roles: GroundedRole[];
  /** Non-colour readings; these need no pixel grounding, only a cited file. */
  typography: BrandAgentResult['typography'] & { sourceIds: number[] } | null;
  mood: string[];
  photographyStyle: { text: string; sourceIds: number[] } | null;
  voice: BrandAgentResult['voice'] & { sourceIds: number[] } | null;
  confidence: number;
  /** Every drop, every miss, in the words a person can check. */
  notes: string[];
  /** The files the agent was shown, for the log and the report. */
  inputs: BrandInput[];
}

export interface BrandAgentOptions {
  browser?: Browser;
  maxPhotos?: number;
  timeoutMs?: number;
  /** Injected by the test: skip the real agent and ground this result instead. */
  resultOverride?: BrandAgentResult;
}

/**
 * Runs the agent-led brand read for one business.
 *
 * Returns null — never throws — when there is nothing to look at, when the agent
 * fails, or when grounding rejects every colour it named. The caller falls
 * through to the deterministic path in every one of those cases.
 */
export async function runBrandAgent(
  businessId: string,
  businessName: string,
  opts: BrandAgentOptions = {},
): Promise<BrandAgentOutcome | null> {
  const inputs = await collectBrandInputs(businessId, { maxPhotos: opts.maxPhotos });
  if (inputs.length === 0) {
    log.info('brand agent skipped: no visual material', { businessId });
    return null;
  }

  const dir = await createAgentInputWorkspace('factory-brand-');
  const ownBrowser = !opts.browser;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const notes: string[] = [];

  try {
    // ── materialise the workspace ─────────────────────────────────────────
    const present: BrandInput[] = [];
    const bytes = new Map<string, Buffer>();
    for (const input of inputs) {
      try {
        const buf = await getObject(input.bucket, input.objectKey);
        await writeFile(path.join(dir, input.file), buf);
        bytes.set(input.file, buf);
        present.push(input);
      } catch (err) {
        // A key in the DB whose object is gone is a storage fact, not a reason
        // to fail: the agent simply sees one file fewer.
        notes.push(`${input.file} could not be read from storage (${input.objectKey})`);
        log.warn('brand agent input missing from storage', {
          businessId, objectKey: input.objectKey, err: String(err).slice(0, 160),
        });
      }
    }
    if (present.length === 0) {
      notes.push('no brand material could be read from storage');
      return null;
    }
    await writeFile(path.join(dir, 'INPUTS.md'), renderInputsMd(businessName, present));

    // ── the agent ─────────────────────────────────────────────────────────
    let result: BrandAgentResult;
    if (opts.resultOverride) {
      result = opts.resultOverride;
    } else {
      try {
        result = await runCodeAgent({
          name: 'brand-identity',
          cwd: dir,
          prompt: `Analyse the brand material in this workspace for **${businessName}**.\n\n`
            + 'Start by reading INPUTS.md, then Read every image file it names.',
          appendSystemPrompt: BRAND_AGENT_PROMPT,
          // Sonnet tier (Roman: "Sonnet 5 достатньо"). `heavy` would spend the
          // builder model on a job that is looking at a dozen images.
          heavy: false,
          kind: 'enrichment',
          // One turn per file to Read, plus room to think and write result.json.
          maxTurns: present.length + 8,
          timeoutMs: opts.timeoutMs ?? 10 * 60_000,
          // Headless even when builds run in tmux: this is a few minutes of
          // looking at images in a scratch dir, with nothing worth attaching
          // to. The shared runner reserves its single web-terminal slot for
          // attachable build sessions.
          terminal: false,
          onUsage: (u) => log.info('agent usage', { businessId, call: 'brand-identity', ...u }),
        }, BrandAgentResultSchema);
      } catch (err) {
        log.warn('brand agent failed; falling back to the deterministic path', {
          businessId, err: String(err).slice(0, 300),
        });
        return null;
      }
    }

    // ── grounding ─────────────────────────────────────────────────────────
    //
    // Only the files the agent actually cited are decoded. Median-cutting six
    // photographs to check one hex that named the logo would cost a browser
    // round-trip per image for nothing.
    const cited = new Set<string>();
    const claims: Array<{ role: GroundedRole['role']; claim: z.infer<typeof PaletteRoleSchema> }> = [];
    for (const role of ['primary', 'accent', 'background', 'onDark'] as const) {
      const claim = result.palette[role];
      if (!claim) continue;
      claims.push({ role, claim });
      cited.add(path.basename(claim.file.trim()).toLowerCase());
    }

    const fileColors: FileColors[] = [];
    if (claims.length > 0) {
      const { launchBrowser } = await import('./capture.js');
      browser = opts.browser ?? await launchBrowser();
      page = await newDecodePage(browser);
      for (const input of present) {
        if (!cited.has(path.basename(input.file).toLowerCase())) continue;
        const buf = bytes.get(input.file);
        if (!buf) continue;
        const decoded = await decodeImage(page, buf, input.contentType);
        if (!decoded) {
          notes.push(`${input.file} could not be decoded, so colours citing it cannot be grounded`);
          fileColors.push({ file: input.file, palette: [] });
          continue;
        }
        // `keepExtremes` on: a logo's deliberate black and a page's off-white
        // ground are both real answers here, and the deterministic path drops
        // them only because it is looking for an ACCENT. This check is asking a
        // narrower question — is this colour in this file — so it must see the
        // whole image. A larger palette also means a fairer check: 12 centroids
        // describe the file better than 5.
        const { palette } = paletteFromImage(decoded, { keepExtremes: true, maxColours: 12 });
        fileColors.push({ file: input.file, palette });
      }
    }

    const roles: GroundedRole[] = [];
    for (const { role, claim } of claims) {
      const verdict = checkGrounding(claim, fileColors);
      const sourceId = sourceIdForFile(claim.file, present);
      if (!verdict.grounded) {
        notes.push(`${role} ${claim.hex} dropped: ${verdict.reason}`);
        continue;
      }
      if (sourceId === null) {
        // Grounded against a file whose source we cannot name is still a fact
        // with no source_id, and those are not written here (CLAUDE.md).
        notes.push(`${role} ${claim.hex} dropped: no source_id for "${claim.file}"`);
        continue;
      }
      roles.push({
        role, hex: claim.hex.toLowerCase(), file: path.basename(claim.file.trim()),
        why: claim.why, sourceId,
      });
    }

    if (roles.length === 0) {
      notes.push('no colour the agent named survived grounding — falling back to measurement');
      log.warn('brand agent produced no grounded colours', { businessId, notes: notes.slice(0, 6) });
      return null;
    }

    // ── the non-colour readings ───────────────────────────────────────────
    //
    // These need no pixel grounding — there is no median cut for "the wordmark
    // is a high-contrast serif" — but they still need a cited file, so a
    // judgement about material we never showed the agent cannot be stored.
    const idsFor = (files: readonly string[]): number[] => {
      const out: number[] = [];
      for (const f of files) {
        const id = sourceIdForFile(f, present);
        if (id !== null && !out.includes(id)) out.push(id);
      }
      return out;
    };
    // Everything shown to the agent, for readings that are about the material as
    // a whole (mood, photography, voice) rather than about one file.
    const allIds = [...new Set(present.map((i) => i.sourceId))];

    const typoIds = idsFor(result.typography.files);
    const typography = (result.typography.family || result.typography.weight || result.typography.case)
      && typoIds.length > 0
      ? { ...result.typography, sourceIds: typoIds }
      : null;
    if (!typography && result.typography.family) {
      notes.push(`typography reading dropped: cites ${JSON.stringify(result.typography.files)}, none of which is a workspace file`);
    }

    const outcome: BrandAgentOutcome = {
      roles,
      typography,
      mood: result.mood.map((m) => m.trim()).filter(Boolean).slice(0, 5),
      photographyStyle: result.photographyStyle
        ? { text: result.photographyStyle, sourceIds: allIds }
        : null,
      voice: result.voice.tone || result.voice.formality
        ? { ...result.voice, sourceIds: allIds }
        : null,
      confidence: result.confidence,
      notes: [...result.notes, ...notes],
      inputs: present,
    };
    log.info('brand agent done', {
      businessId,
      files: present.length,
      grounded: roles.map((r) => `${r.role}=${r.hex}@${r.file}`),
      dropped: notes.filter((n) => n.includes('dropped')).length,
      confidence: result.confidence,
      mood: outcome.mood,
    });
    return outcome;
  } catch (err) {
    log.warn('brand agent errored; falling back to the deterministic path', {
      businessId, err: String(err).slice(0, 300),
    });
    return null;
  } finally {
    if (ownBrowser && browser) await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
