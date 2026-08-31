/**
 * Builder workspace preparation (SPEC §2.3 "ізольований workspace", §4 stage 10).
 *
 * Each build gets its own directory `sites/<businessId>/<projectId>/` containing:
 *   - a copy of site-template (no node_modules/.next/out — those are rebuilt)
 *   - input/{snapshot,brief,design}.json — the only facts that exist
 *   - public/assets/**    real evidence photos
 *   - public/generated/** AI media, listed separately in MEDIA-MANIFEST.json
 *   - .claude/skills/     the official GSAP skills, so the agent can consult them
 *   - references/         the curated niche reference pack (read-only inspiration)
 *   - BUILD-TASK.md       the hard rules, written by code, not by a model
 *
 * The agent has no network beyond package registries and no DB access, so this
 * directory is the complete universe it can build from.
 */
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getObject } from '../lib/storage.js';
import { config } from '../config.js';
import {
  HERO_MOTION_COMPONENT, PHOTO_GRADES, WOW_MAX,
  motionRefDir, renderWowGate, renderWowRubric,
} from './motionRefs.js';
import { log } from '../lib/logger.js';
import type { ContentBrief } from './schemas.js';
import type { ArtDirection } from './schemas.js';
import type { BuildSnapshot } from './snapshot.js';
import type { RubricVerdict } from './rubric.js';

export const SITES_ROOT = path.resolve('sites');
export const TEMPLATE_DIR = path.resolve('site-template');
const SKILLS_SRC = path.resolve('skills');
const REFERENCES_SRC = path.resolve('references');

/** Directories that must never be copied into a fresh workspace. */
const TEMPLATE_EXCLUDE = new Set(['node_modules', '.next', 'out', '.screenshots', 'result.json', 'tsconfig.tsbuildinfo']);

export interface HeroMediaPlan {
  /** `clip` = an mp4 exists; `ken-burns` = animate a real still; `none` = static. */
  kind: 'clip' | 'ken-burns' | 'none';
  /** Workspace-relative path, e.g. `generated/hero_clip-abc.mp4`. */
  file: string | null;
  /** The real evidence photo the motion derives from. */
  sourceFile: string | null;
  aiGenerated: boolean;
  durationSec?: number;
  /** Ken Burns parameters when kind === 'ken-burns'. */
  kenBurns?: Record<string, unknown>;
  respectReducedMotion: true;
  note: string;
}

export interface WorkspacePlan {
  dir: string;
  snapshot: BuildSnapshot;
  brief: ContentBrief;
  design: ArtDirection;
  verdict: RubricVerdict;
  heroMedia: HeroMediaPlan;
  /** Files written under public/, workspace-relative. */
  assetFiles: string[];
  generatedFiles: string[];
}

export function workspaceDir(businessId: string, projectId: number): string {
  return path.join(SITES_ROOT, businessId, String(projectId));
}

/** `out/` when it exists (a real export), else the workspace itself. */
export function outputDir(dir: string): string {
  const out = path.join(dir, 'out');
  return existsSync(path.join(out, 'index.html')) ? out : dir;
}

/**
 * Copy the template. `cp` with a filter, rather than a glob, so a template file
 * added later is picked up automatically without touching this list.
 */
async function copyTemplate(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(TEMPLATE_DIR, target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(TEMPLATE_DIR, src);
      if (rel === '') return true;
      const first = rel.split(path.sep)[0]!;
      return !TEMPLATE_EXCLUDE.has(first);
    },
  });
}

/** GSAP skills so the builder can consult the official docs offline. */
async function copySkills(target: string): Promise<string[]> {
  const dest = path.join(target, '.claude', 'skills');
  await mkdir(dest, { recursive: true });
  const copied: string[] = [];
  if (!existsSync(SKILLS_SRC)) return copied;
  for (const entry of await readdir(SKILLS_SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('gsap-')) continue; // gen-image needs Codex; not useful in-workspace
    await cp(path.join(SKILLS_SRC, entry.name), path.join(dest, entry.name), { recursive: true });
    copied.push(entry.name);
  }
  return copied;
}

/**
 * Move the landing.gallery previews stage 9 staged for this business into the
 * workspace at `references/gallery/`.
 *
 * They were downloaded during stage-9 prep (see `galleryContext` in
 * `src/workers/contentDesign.ts`) because that is where the network is; the
 * builder workspace has none. Copying rather than re-fetching is what keeps that
 * property true. Absent staging is the normal case whenever the feature is off
 * or the endpoint had nothing for this niche, and it is silent.
 */
async function copyGalleryReferences(target: string, businessId: string): Promise<string[]> {
  const src = path.join(SITES_ROOT, businessId, 'gallery');
  if (!existsSync(src)) return [];
  const dest = path.join(target, 'references', 'gallery');
  await mkdir(dest, { recursive: true });
  const copied: string[] = [];
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await copyFile(path.join(src, entry.name), path.join(dest, entry.name));
    copied.push(`references/gallery/${entry.name}`);
  }
  return copied;
}

/**
 * Copy the ONE chosen motion reference into `<workspace>/references/<slug>/`.
 *
 * Only `notes.md`, `hero.jpg` and `full.jpg` — never the `.webm`. The builder
 * agent cannot watch a video, so a 2-6MB file per workspace would buy nothing,
 * and copying the whole 60MB pack into every build was the previous behaviour's
 * real cost. The stills are what the agent can actually read, and they are the
 * same files the stage-11 critic compares the built page against.
 *
 * Returns the workspace-relative paths that exist, so BUILD-TASK.md can point at
 * files that are really there rather than promising a missing hero.jpg.
 */
async function copyMotionReference(target: string, slug: string): Promise<string[]> {
  const src = motionRefDir(slug);
  if (!slug || !existsSync(src)) {
    log.warn('chosen motion reference not on disk; workspace gets no reference stills', { slug });
    return [];
  }
  const dest = path.join(target, 'references', slug);
  await mkdir(dest, { recursive: true });
  const copied: string[] = [];
  for (const file of ['notes.md', 'hero.jpg', 'full.jpg']) {
    const from = path.join(src, file);
    if (!existsSync(from)) continue;
    await copyFile(from, path.join(dest, file));
    copied.push(`references/${slug}/${file}`);
  }
  return copied;
}

/** Download the business's assets out of object storage into public/. */
async function materializeAssets(
  snapshot: BuildSnapshot,
  target: string,
): Promise<{ assetFiles: string[]; generatedFiles: string[] }> {
  const assetsDir = path.join(target, 'public', 'assets');
  const generatedDir = path.join(target, 'public', 'generated');
  await mkdir(assetsDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });

  const assetFiles: string[] = [];
  const generatedFiles: string[] = [];
  for (const asset of snapshot.assets) {
    const base = path.basename(asset.file);
    const dir = asset.aiGenerated ? generatedDir : assetsDir;
    try {
      const buf = await getObject('assets', asset.objectKey);
      await writeFile(path.join(dir, base), buf);
      (asset.aiGenerated ? generatedFiles : assetFiles).push(asset.file);
    } catch (err) {
      // A missing object is evidence loss, not a reason to fail the whole build:
      // the snapshot entry is dropped so the agent never references a 404.
      log.warn('asset missing from storage, dropped from workspace', {
        businessId: snapshot.businessId, objectKey: asset.objectKey, err: String(err).slice(0, 200),
      });
    }
  }
  const present = new Set([...assetFiles, ...generatedFiles]);
  snapshot.assets = snapshot.assets.filter((a) => present.has(a.file));
  // `brand.logo` points at one of those same files. If the object went missing
  // it has just been dropped from `assets[]`, and leaving the brand reference
  // behind would have BUILD-TASK.md order the agent to put a 404 in the header.
  if (snapshot.brand.logo && !present.has(snapshot.brand.logo.file)) {
    log.warn('logo object missing from storage, dropped from the brand section', {
      businessId: snapshot.businessId, file: snapshot.brand.logo.file,
    });
    snapshot.brand.logo = null;
  }
  return { assetFiles, generatedFiles };
}

/**
 * Human-readable manifest of what may and may not be claimed about each file.
 * The agent reads this next to the snapshot; the provenance checker enforces it.
 */
function mediaManifest(snapshot: BuildSnapshot, hero: HeroMediaPlan): string {
  const rows = snapshot.assets.map((a) => ({
    file: a.file,
    kind: a.kind,
    dimensions: a.width && a.height ? `${a.width}x${a.height}` : 'unknown',
    aiGenerated: a.aiGenerated,
    mayDepictTheBusiness: !a.aiGenerated,
    usage: a.aiGenerated
      ? 'DECORATIVE ONLY — background/texture/pattern. alt="" . Never captioned as this business, its work, staff or interior.'
      : 'Real evidence photo of this business. May be the hero and may illustrate real claims. Needs meaningful alt text.',
    source: a.sourceUrl,
    generator: a.generator,
  }));
  return JSON.stringify({ heroMedia: hero, assets: rows }, null, 2);
}

/** The hard rules, authored by code so a model can never soften them. */
function buildTaskDoc(plan: {
  snapshot: BuildSnapshot;
  brief: ContentBrief;
  design: ArtDirection;
  verdict: RubricVerdict;
  heroMedia: HeroMediaPlan;
  skills: string[];
  niche: string;
  /** Workspace-relative files copied from the chosen motion reference. */
  referenceFiles: string[];
  /** Workspace-relative landing.gallery previews, empty when the feature is off. */
  galleryFiles: string[];
}): string {
  const { snapshot, brief, design, verdict, heroMedia, skills, niche, referenceFiles, galleryFiles } = plan;
  const isGreek = snapshot.language.toLowerCase().startsWith('el');
  const contactLines = snapshot.contacts.length
    ? snapshot.contacts.map((c) => `  - ${c.channel}: ${c.value}${c.verified ? ' (verified)' : ' (unverified — usable, but the verified ones come first)'}`).join('\n')
    : '  - NONE. Do not invent one. Use the address as the only contact block.';

  return `# BUILD TASK — ${snapshot.name}

You are building a **private demo website** for a real business. It will be shown to the
owner, who knows their business better than you do. Every invented fact is a credibility hole.

Read in this order: this file → \`references/${design.referenceSlug}/notes.md\` (+ its \`hero.jpg\`
and \`full.jpg\`) → \`DESIGN.md\` → \`components/README.md\` → \`references/${niche}/README.md\`.

## STEP 0 — LOOK, before you write a line of code

You are a multimodal model; use it. Open these IMAGES with the Read tool, in this order,
and for each write 1-2 sentences (they go into \`referenceNotes\` in result.json — a required
field, and the pipeline rejects a result without it):

1. \`references/${design.referenceSlug}/hero.jpg\` and \`full.jpg\` — the award-winning bar this
   direction was chosen against. Note the type scale, the crop language, how much air it uses.
2. Every image in \`references/gallery/\` (if present) — current real-world layouts fetched for
   THIS business. Note one compositional idea per image worth keeping or rejecting.
   Where a pair exists (\`N.webp\` + \`N-full.webp\`), the \`-full\` file is the one that matters:
   it is the page top to bottom — study the section rhythm, how density changes as you scroll,
   and how the page ends. The short file is only the masthead.
3. The 3-5 strongest photos in \`public/assets/\` — the actual material you are designing WITH.
   Note their light, tone and orientation: the page must be composed around what they really
   look like, not around what the brief says about them.

A build that starts coding without these Reads produces a template with the right words on it —
that is the failure mode this step exists to kill (measured on the first shipped demo: zero
reference images opened, design rejected).

## Inputs (the complete universe of facts)

| File | What it is |
|---|---|
| \`input/snapshot.json\` | The ONLY source of truth. Every fact on the page must trace to it. |
| \`input/brief.json\` | Content brief: sections, offer, CTA, tone, allowed and forbidden claims. |
| \`input/design.json\` | The chosen art direction. Implement it — it was picked by a scored rubric. |
| \`input/rubric.json\` | Why this direction won, and any open vetoes you must resolve. |
| \`MEDIA-MANIFEST.json\` | Per-file rules: which images may depict the business and which may not. |
| \`public/assets/\` | Real evidence photos. Reference as \`/assets/<file>\`. |
| \`public/generated/\` | AI-generated decoration. Reference as \`/generated/<file>\`. |

You have **no internet** except the npm registry, and **no database**. If a fact is not in
\`input/snapshot.json\`, it does not exist and the section that needed it goes away.

## Hard rules (any violation fails the job)

1. **Facts only from the snapshot.** No invented services, prices, hours, reviews, ratings,
   testimonials, client names, years in business, "since 20XX", awards, certifications, staff
   counts, or superlatives ("best in ${snapshot.city ?? 'town'}", "award-winning", "trusted by hundreds").
2. **Contacts are exact.** The only contact details that may appear anywhere on the page:
${contactLines}
   A phone number, email or booking URL not on that list is an automatic QA failure — an
   automated provenance check greps the built HTML and compares it against the snapshot.
3. **The logo.** ${snapshot.brand.logo ? `This business HAS its own mark: \`/${snapshot.brand.logo.file}\`${snapshot.brand.logo.vector ? ' (SVG — scales to any size)' : snapshot.brand.logo.width ? ` (${snapshot.brand.logo.width}x${snapshot.brand.logo.height} raster — never enlarge past 1x, it will blur)` : ''},
   found on their ${snapshot.brand.logo.origin}. Put it in the header, and in the footer.
   **Use the file as it is.** Do not redraw it, do not trace it into SVG, do not recolour it,
   do not put it inside a coloured badge or circle it did not come with, and do not replace it
   with the business name set in a typeface. It is the one element on this page the owner will
   recognise instantly, and any alteration reads as a mistake.
   Give it a sensible box (a header mark is usually 28-48px tall), \`object-fit: contain\`, and
   \`alt="${snapshot.name}"\`. If it is a dark mark on a dark section, place it on its own light
   surface rather than inverting it.` : `This business publishes NO logo we could verify.
   Set its NAME as a wordmark instead — that is a legitimate, honest identity, and it is what a
   typographic direction is for. **Do not invent an emblem, monogram, icon or crest for them**,
   and do not borrow a mark from anywhere. A fabricated logo is a fabricated fact.
   The wordmark must FIT: the full name visible inside the viewport at every breakpoint — size
   display type with clamp()/vw so "BEAUTIFUL" scales down before it ever overflows. A hero
   word cut mid-glyph is measured by the QA gate and fails the build, so an oversized wordmark
   is not a style this contract permits.`}
4. **Images.** Only files under \`public/assets/\` and \`public/generated/\`.
   - \`/assets/*\` are REAL photos of this business: they may be the hero and may illustrate real claims.
   - \`/generated/*\` are AI-generated: **decorative only** (texture, pattern, atmospheric background,
     og-image), \`alt=""\`, and never captioned or implied to be this business, its work, its interior
     or its staff. See MEDIA-MANIFEST.json.
   - Nothing hotlinked. No Unsplash, no placeholder services, no stock.
5. **Language.** All visible copy, microcopy and alt text in **${snapshot.languageName}** (\`${snapshot.language}\`).${isGreek ? `
   **GREEK FONT TRAP:** requesting a subset a font lacks is a HARD BUILD FAILURE
   ("Unknown subset \`greek\` for font \`X\`"). The default Fraunces/Outfit pair does NOT support
   Greek. The art direction names Greek-verified fonts — use exactly those, and pass
   \`subsets: ['greek', 'latin']\`. Do not substitute a font of your own choosing.` : ''}
6. **noindex stays.** \`robots: { index: false, follow: false }\` in the layout metadata is
   mandatory — these demos are private.
7. **Responsive, zero horizontal overflow** at 390px, 768px and 1440px. This is a hard QA gate.
8. **Reduced motion.** \`prefers-reduced-motion: reduce\` must render a complete, readable,
   fully visible page. Never leave content at \`opacity: 0\` waiting for a cancelled animation.
   Wrap GSAP work in \`motionSafe()\` from \`@/lib/gsap\`.
9. **Static export only.** No route handlers, server actions, middleware, ISR or
   \`next/image\` optimization. A contact form with no backend is a broken promise — use real
   \`tel:\`/\`mailto:\` links instead.
10. **Follow the art direction.** \`input/design.json\` is a contract: its layout skeleton,
   typography pair, palette, motion concept, hero treatment, named reference and pool
   components. Deviating turns a chosen design back into a generic template.
11. **Finish with a green \`pnpm build\`** producing \`out/index.html\`. Run it yourself and fix
    your own errors. The pipeline re-runs the build independently and does not take your word.
12. **LOOK AT YOUR OWN PAGE before handing it in.** After \`pnpm build\` is green, run
    \`pnpm shot\` — it serves \`out/\` on loopback and writes \`_shots/desktop.png\` and
    \`_shots/mobile.png\`. Read both PNGs. Judge them as a stranger would: awkward crops, a
    band that reads as a template, broken spacing, anything moving that should not. Fix what
    you see, rebuild, re-shot — at least one full look is mandatory, and what you saw and
    changed goes into \`selfReview\` in result.json (required). If \`pnpm shot\` exits with its
    "браузер недоступний" message, do not fight the environment: say exactly that in
    \`selfReview\` and move on.
13. **LOOK AT YOUR OWN MOTION.** Then run \`pnpm shot --motion\`: it captures the exact
    frames the independent critic will judge — \`_shots/motion-load-t*.png\` (the first 3.6s
    after load) and \`_shots/motion-scroll-*pct.png\` (six scroll depths, 450ms after
    arriving). Read them and verify EVERY mechanic from «The 3-4 mechanics to implement»
    against the frames, by name: t0.15 vs t1.60 — did the entrance happen; t2.40 vs t3.60 —
    is the hero still alive after entrances; adjacent scroll frames — do sections actually
    transform as the page scrolls, or does everything sit settled (that is a static site
    with entrance effects, the exact «default AI template» rejection). A mechanic you cannot
    SEE working in these frames is not implemented, whatever the code says. Per-mechanic
    verdicts go into \`selfReview\`. The critic sees the same frames — anything you wave
    through here comes back as an iteration.

## The chosen direction: "${design.name}"

${design.bigIdea}

- **THE SIGNATURE — build this one with the most care:** ${design.signature}
  Spend the page's boldness here and keep everything around it quiet. If the finished page
  would lose nothing by deleting this element, the page has failed as a design.
- **Reference:** ${design.reference.name} — borrow: ${design.reference.borrowedMechanics.join('; ')}
- **Motion reference:** \`${design.referenceSlug}\` (see the motion section below)
- **Typography:** ${design.typography.displayFont} (display) + ${design.typography.bodyFont} (body).
  ${design.typography.hierarchyRule} Micro-labels: ${design.typography.microLabelTreatment}
- **Palette:** bg ${design.palette.background}, fg ${design.palette.foreground}, ONE accent ${design.palette.accent}
  (${design.palette.accentUsage}). Derived from: ${design.palette.derivedFrom}
  Palette source: \`${design.palette.paletteSource}\` — ${design.palette.brandAlignment}${snapshot.brand.paletteSource !== 'none' ? `
  **This business's MEASURED brand colours** (from its ${snapshot.brand.paletteSource}): primary
  \`${snapshot.brand.primary?.hex ?? '—'}\`, accent \`${snapshot.brand.accent?.hex ?? '—'}\`${snapshot.brand.accent?.onLight ? `
  (contrast-corrected: \`${snapshot.brand.accent.onLight}\` on light, \`${snapshot.brand.accent.onDark}\` on dark —
  use these for text and buttons, the raw accent is the brand colour and not an accessible one)` : ''}.
  These are not decoration: they are why this page is THIS business's page and not a template.
  The motion reference contributes mechanics only — never take a colour from it.` : ''}
- **Motion:** ${design.motionConcept.idea} — ${design.motionConcept.techniques.join(', ')}.
  Reduced motion: ${design.motionConcept.reducedMotionPlan}
- **Hero:** ${design.heroTreatment.kind}${design.heroTreatment.assetFile ? ` using \`${design.heroTreatment.assetFile}\`` : ''}.
  ${design.heroTreatment.description}
- **Pool components (max 4, do not add more):** ${design.poolComponents.length ? design.poolComponents.join(', ') : 'none — typography and photography carry the page'}
- **Layout skeleton:**
${design.layoutSkeleton.map((s, i) => `  ${i + 1}. \`${s.sectionId}\` [${s.heightFeel}] — ${s.composition}`).join('\n')}

## Motion: this is what the demo is judged on

A previous demo passed every correctness gate and was rejected as a default AI template
because **nothing on it moved**. The page you build is scored on six axes, 0-3 each, from
screenshots AND from motion frames captured at 0.15s / 0.8s / 1.6s / 2.4s / 3.6s after load
and at six scroll positions.

A browser measures the hero deterministically, in two windows: pixels changed during the
entrance (0.15s→1.6s) and pixels changed AFTER it (2.4s→3.6s). **Both must show movement.** A
block that fades in once and then sits perfectly still fails as a static hero — the second
window exists specifically to catch that.

**${renderWowGate()}**

${renderWowRubric()}

### The reference for this build: \`${design.referenceSlug}\`

${referenceFiles.length
  ? `Read it before you write any code:
${referenceFiles.map((f) => `- \`${f}\`${f.endsWith('notes.md') ? ' — mechanics, how to reproduce them in our stack, and what NOT to borrow'
    : f.endsWith('hero.jpg') ? ' — its above-the-fold frame; this is the bar for your first screen'
    : ' — its full-page screenshot; this is the bar for section rhythm'}`).join('\n')}

The same \`hero.jpg\` and \`full.jpg\` are shown to the QA critic next to screenshots of YOUR
page, with the question "how close does this get to this?". Look at them.`
  : `(The reference files are not in this workspace — build from the mechanics below.)`}
${galleryFiles.filter((f) => !f.endsWith('index.md')).length
  ? `
### Additional layout references — \`references/gallery/\`

Screenshots of current landing pages, fetched automatically while the direction was chosen
(\`references/gallery/index.md\` says what each one is and why it was fetched)${design.galleryRefs?.length
  ? `. The art director cited: ${design.galleryRefs.map((u) => `\`${u}\``).join(', ')}` : '.'}

They are SECONDARY and OPTIONAL: look at them for layout composition and mood if it helps.
**Nothing about the page's behaviour comes from here** — the motion mechanics are the ones
listed below, from \`${design.referenceSlug}\`. **Never take a colour, a photograph or a line of
copy from them.** The palette is this business's, and it is already decided above.
`
  : ''}
### THE SCENE MAP — the page IS this sequence

Motion system: ${design.sceneMap.system}

${design.sceneMap.scenes.map((sc, i) =>
  `${i + 1}. \`${sc.section}\` [${sc.trigger}] — ${sc.motion}\n   → handoff: ${sc.handoff}`).join('\n')}

This is a CONTRACT, not inspiration: implement every scene with its stated trigger, keep the
one motion system across all of them (same easing family, same duration scale), and treat the
handoffs as seriously as the scenes — the transitions between sections are what separates a
motion site from a page with entrance effects. Sections absent from the map are deliberately
static; do not decorate them. The critic verdicts each scene by name from motion frames.

Wire the triggers through \`@/lib/scenes\` (\`loadScene\` / \`enterScene\` / \`scrubScene\` /
\`pinScene\`, tokens \`EASE\`/\`DUR\`): it carries the shared ScrollTrigger defaults and the
reduced-motion guard, so scenes stay consistent and nothing re-invents global wiring. What
happens INSIDE each timeline is yours; the wiring is not.

### The 3-4 mechanics to implement (no more)

${design.mechanics.map((m, i) => `${i + 1}. **${m.name}** — use \`${m.component}\`, in ${m.where}`).join('\n')}

Three or four is the cap, not a target to exceed. Every reference in the pack lists five or
six mechanics; taking all of them produces a showreel, not a business page.

- **Hero motion: \`${design.heroMotion}\`** → ${HERO_MOTION_COMPONENT[design.heroMotion]}${design.heroMotion === 'none'
  ? `\n  Justified as: ${design.heroMotionJustification ?? '(no justification given — this will fail QA)'}`
  : '\n  The first screen must move before the visitor touches anything.'}
- **Preloader: ${design.preloader ? 'yes' : 'no'}.**${design.preloader
  ? ` Typographic (the real headline + a counter), **hard-capped at 1.2s**, dismissed on \`window.load\`,
  skipped entirely under reduced motion. The reference holds the visitor for several seconds — that
  reads as a broken site on a demo opened cold on 4G. The cap is the whole point of building our own.`
  : ' Do not add one.'}
- **Type as design:** ${design.typeAsDesign}
- **Photo grade:** ${design.photoGrade
  ? `\`.${design.photoGrade.replace(/^\./, '')}\` on EVERY photograph — one filter line is what makes
  mixed-quality client photos read as one shoot. Available: ${PHOTO_GRADES.join(', ')}.`
  : 'none specified (no photographs on this page).'}${snapshot.language.toLowerCase().startsWith('el') ? `
- **Greek + italic:** if any mechanic depends on roman/italic mixing, the display face must be
  **EB_Garamond** — it is the Greek-subset face in our list with a true italic. GFS_Didot is
  single-weight roman only and cannot do it.` : ''}

### Performance budget and reduced motion

- Static export on a mid-range phone. **No WebGL, no three.js**, no new heavy dependency.
- Animate \`transform\` and \`opacity\` only; never animate layout properties on scroll.
- Any video: \`autoPlay muted loop playsInline\`, a required \`poster\` still, \`object-fit: cover\`,
  and paused when off-screen via \`IntersectionObserver\`.
- \`prefers-reduced-motion: reduce\` is a correctness requirement, not a courtesy: infinite loops
  actually stop (an infinite tween at \`0.01ms\` still burns CPU), preloader skipped, video
  replaced by its poster, and **nothing left at \`opacity: 0\`**. QA screenshots the reduced-motion
  render and any invisible text is a high-severity failure.
- At least 3 of the components you import must be visible in the DOM *and* animating. Importing a
  component you never render scores nothing.
- Magnetic / cursor-follow effects are for SMALL, compact controls — an icon, a pill CTA. Never
  attach them to headline-scale text, a phone number, or anything wider than ~240px: a large
  element chasing the cursor reads as a glitch, not a delight (shipped and rejected, 2026-08-22:
  a 6rem phone number on \`MagneticButton\`). Screenshot QA cannot see cursor effects, so nothing
  downstream catches this — the rule here is the only gate.

### Hero media

${heroMedia.kind === 'clip'
  ? `A generated hero clip exists at \`/${heroMedia.file}\` (${heroMedia.durationSec ?? '?'}s, derived from the real photo \`${heroMedia.sourceFile}\`).
Use it as a muted, looping, \`playsInline\` background video with the real photo as its \`poster\`.
Under \`prefers-reduced-motion: reduce\` show the still poster instead — do not autoplay.
It is AI-derived motion over a real photo: never caption it as raw footage of the business.
**ONE MOTION SOURCE PER HERO.** The clip already moves — a slow pan/zoom is baked into the
file. Do NOT layer anything on top: no scroll-scrub scale, no parallax, no transform tweens on
the \`<video>\` or its wrapper, and no CSS upscale beyond what \`object-fit: cover\` needs.
A doubly-animated, upscaled clip reads as a shaking background (shipped and rejected,
2026-08-22: baked pan/zoom + GSAP scroll-scale 1.04→1.13 + \`scale-[1.95]\` on one hero).`
  : heroMedia.kind === 'ken-burns'
  ? `No video file. Animate the REAL photo \`${heroMedia.sourceFile}\` with a slow Ken Burns move
(CSS or GSAP, transform only, ~${heroMedia.durationSec ?? 20}s, subtle). Under reduced motion render it perfectly static.
Parameters: ${JSON.stringify(heroMedia.kenBurns ?? {})}`
  : `No hero motion available. Build a still hero. ${heroMedia.note}`}

${verdict.chosen.name === design.name && verdict.ranking[0]?.vetoes.length
  ? `### Open vetoes you MUST resolve\n\n${verdict.ranking[0]!.vetoes.map((v) => `- ${v}`).join('\n')}\n`
  : ''}
## Content brief essentials

- **One-liner:** ${brief.businessOneLiner}
- **Main offer:** ${brief.mainOffer}
- **Primary CTA:** "${brief.primaryCta.label}" → \`${brief.primaryCta.href}\`
- **Tone:** ${brief.toneOfVoice}
- **Copy limits:** headlines ≤ ${brief.copyConstraints.maxHeadlineWords} words, paragraphs ≤ ${brief.copyConstraints.maxParagraphSentences} sentences.
- **Banned phrases:** ${brief.copyConstraints.bannedPhrases.join(', ') || '(see DESIGN.md ban-list)'}
- **Forbidden claims (evidence does not support these):**
${brief.forbiddenClaims.length ? brief.forbiddenClaims.map((c) => `  - ${c}`).join('\n') : '  - (none listed — the DESIGN.md rules still apply)'}
- **Deliberate omissions:**
${brief.omissions.length ? brief.omissions.map((o) => `  - ${o}`).join('\n') : '  - (none)'}

Full section list and per-section snapshot bindings: \`input/brief.json\`.

## Available skills

${skills.length ? `Official GSAP skills are installed in \`.claude/skills/\`: ${skills.join(', ')}.
Consult them before writing scroll-linked or timeline animation.` : '(none installed)'}

## Definition of done

- [ ] \`pnpm install && pnpm build\` green, \`out/index.html\` exists
- [ ] Every fact traces to \`input/snapshot.json\`
- [ ] Only snapshot contacts appear; no invented phone/email/booking link
- [ ] No horizontal overflow at 390 / 768 / 1440
- [ ] No console errors, no broken images
- [ ] **The hero moves on load** (\`${design.heroMotion}\`) — open the page and watch it
- [ ] **All ${design.mechanics.length} mechanics above are implemented and visibly animating**, not just imported
- [ ] Reduced motion: everything visible and readable, loops stopped, preloader skipped
- [ ] noindex present in the exported HTML
- [ ] Re-read the DESIGN.md §3 ban-list against your own page, honestly
- [ ] \`result.json\` written

Write \`result.json\` at the workspace root when done:
\`{"ok": boolean, "pages": string[], "notes": string, "usedAssets": string[], "unresolved": string[]}\`
Put anything you could not satisfy in \`unresolved\` — an honest gap is worth more than a
plausible invention.
`;
}

/**
 * Create (or refresh) a build workspace. `fresh: false` keeps an existing
 * workspace so a QA fix iteration edits the SAME code the agent already wrote.
 */
export async function prepareWorkspace(opts: {
  snapshot: BuildSnapshot;
  brief: ContentBrief;
  design: ArtDirection;
  verdict: RubricVerdict;
  heroMedia: HeroMediaPlan;
  projectId: number;
  niche: string;
  fresh?: boolean;
}): Promise<WorkspacePlan> {
  const { snapshot, brief, design, verdict, heroMedia, projectId, niche } = opts;
  const dir = workspaceDir(snapshot.businessId, projectId);
  const fresh = opts.fresh ?? true;

  if (fresh) {
    // The live build log is a record of the run that is HAPPENING, and the
    // builder has already written its opening stage lines by the time it gets
    // here. Wiping the directory under it would blank the panel Roman is
    // watching and reset the reader's byte offset mid-poll, so it is carried
    // across the wipe rather than treated as build output.
    const logFile = path.join(dir, 'build-log.ndjson');
    const carried = existsSync(logFile) ? await readFile(logFile).catch(() => null) : null;
    await rm(dir, { recursive: true, force: true });
    await copyTemplate(dir);
    if (carried) await writeFile(logFile, carried);
  }

  const skills = await copySkills(dir);

  // References are inspiration, not evidence — copied read-only next to the code.
  // The motion pack is excluded wholesale here (60MB, mostly video the agent
  // cannot watch); only the ONE chosen reference's stills and notes go in, below.
  if (existsSync(REFERENCES_SRC)) {
    await cp(REFERENCES_SRC, path.join(dir, 'references'), {
      recursive: true,
      filter: (src) => path.relative(REFERENCES_SRC, src).split(path.sep)[0] !== 'motion',
    });
  }
  const referenceFiles = await copyMotionReference(dir, design.referenceSlug);
  const galleryFiles = await copyGalleryReferences(dir, snapshot.businessId);

  const { assetFiles, generatedFiles } = await materializeAssets(snapshot, dir);

  const inputDir = path.join(dir, 'input');
  await mkdir(inputDir, { recursive: true });
  await writeFile(path.join(inputDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  await writeFile(path.join(inputDir, 'brief.json'), JSON.stringify(brief, null, 2));
  await writeFile(path.join(inputDir, 'design.json'), JSON.stringify(design, null, 2));
  await writeFile(path.join(inputDir, 'rubric.json'), JSON.stringify(verdict, null, 2));
  await writeFile(path.join(dir, 'MEDIA-MANIFEST.json'), mediaManifest(snapshot, heroMedia));
  await writeFile(
    path.join(dir, 'BUILD-TASK.md'),
    buildTaskDoc({ snapshot, brief, design, verdict, heroMedia, skills, niche, referenceFiles, galleryFiles }),
  );

  log.info('workspace prepared', {
    businessId: snapshot.businessId, projectId, dir, fresh,
    assets: assetFiles.length, generated: generatedFiles.length, skills: skills.length,
  });

  return { dir, snapshot, brief, design, verdict, heroMedia, assetFiles, generatedFiles };
}

/**
 * Reclaim the bulk of a finished workspace.
 *
 * A built workspace is ~735MB, almost entirely `node_modules`; a 30-business
 * campaign would be ~22GB. After a terminal state (deployed, or needs_human /
 * failed) the heavy build artefacts are no longer needed — the deployed copy
 * lives in `deploys/<token>/`, and the QA reports and screenshots live in object
 * storage. Sources, `input/`, `BUILD-TASK.md`, `QA-ISSUES.md` and `result.json`
 * are KEPT (a few MB) so the build stays inspectable and reproducible: a rebuild
 * just re-runs `pnpm install`.
 *
 * Controlled by `WORKSPACE_GC` (default on). Never throws — failing to reclaim
 * disk must not fail a deploy that already succeeded.
 *
 * ONE exception, and it is the whole reason this function takes a reason:
 * `needs_human_review` is not "finished", it is "waiting for Roman". He has to
 * LOOK at the page the critic rejected before deciding to ship it, iterate on it
 * or drop it, and there is no deployed copy to look at — the whole point is that
 * it never reached deploy. So `out/` (the built export, a few MB) is kept for
 * that reason only, and the control UI serves it read-only as a preview.
 * `node_modules` still goes: it is 700MB and `pnpm install` rebuilds it.
 */
export async function collectWorkspaceGarbage(dir: string, reason: string): Promise<{ removed: string[]; freedMb: number }> {
  const removed: string[] = [];
  let freedBytes = 0;
  if (!config.build.workspaceGc) return { removed, freedMb: 0 };

  const targets = reason === 'needs_human_review'
    ? ['node_modules', '.next', 'references', '_shots']
    : ['node_modules', '.next', 'out', 'references', '_shots'];

  for (const name of targets) {
    const target = path.join(dir, name);
    if (!existsSync(target)) continue;
    try {
      freedBytes += await dirSize(target);
      await rm(target, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      log.warn('workspace gc failed for one entry', { dir, name, err: String(err).slice(0, 200) });
    }
  }

  const freedMb = Math.round(freedBytes / 1_048_576);
  if (removed.length) {
    log.info('workspace garbage collected', { dir, reason, removed, freedMb,
      note: '`pnpm install` in this directory recreates node_modules for a rebuild' });
  }
  return { removed, freedMb };
}

/** Best-effort recursive size; used only to report how much GC reclaimed. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += await stat(full).then((st) => st.size).catch(() => 0);
  }
  return total;
}

/** Append QA issues into the workspace so the next agent turn sees them as a file. */
export async function writeQaIssues(dir: string, markdown: string): Promise<void> {
  await writeFile(path.join(dir, 'QA-ISSUES.md'), markdown);
}
