/**
 * Stage 11 — visual QA loop (SPEC §4, §2.4).
 *
 * Two independent layers, deliberately in this order:
 *
 *   1. DETERMINISTIC (Playwright, no model): the exported site is served over http
 *      and loaded at 390/768/1440 — horizontal overflow, console errors, failed
 *      requests, stretched images, a verified contact actually being visible,
 *      noindex, and a reduced-motion pass that must leave nothing invisible.
 *      These are facts; a model cannot argue with them.
 *   2. CRITIQUE (multimodal): a separate agent READS the screenshot files and
 *      scores the §2.4 rubric — typographic hierarchy, spacing rhythm, photo
 *      treatment, motion appropriateness — plus the anti-slop ban-list.
 *
 * Issues from both, plus any provenance findings the builder passed through, are
 * written into the SAME workspace as QA-ISSUES.md and the builder iterates in place.
 * After MAX_QA_ITERATIONS the business goes to needs_review and the job to
 * needs_human — never an infinite loop, never a silently-shipped broken demo.
 */
import { chromium, type Browser } from 'playwright';
import path from 'node:path';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getObject, putRaw } from '../lib/storage.js';
import { serveDir } from '../lib/serveDir.js';
import { config } from '../config.js';
import { runAgent } from '../agents/agent.js';
import { createAgentInputWorkspace } from '../agents/transport.js';
import { parkBuildForHumanReview } from '../orchestrator/buildReviewDecision.js';
import { JobSkippedError } from '../orchestrator/jobSkipped.js';
import { commitWorkflow, NeedsHumanError, type JobPayload } from '../orchestrator/queue.js';
import { buildSnapshot, realPhotos, type BuildSnapshot } from '../build/snapshot.js';
import { VisualCritiqueSchema, type QaIssue } from '../build/schemas.js';
import { evaluateLayoutQuality } from '../build/layoutQuality.js';
import {
  WOW_MAX, motionRefDir, renderWowGate, renderWowRubric, wowVerdict,
} from '../build/motionRefs.js';
import { collectWorkspaceGarbage, outputDir, writeQaIssues } from '../build/workspace.js';
import { buildLogPath, logStage } from '../build/buildLog.js';
import { notifyTelegram, uiLinks } from '../telegram/notify.js';
import { log } from '../lib/logger.js';
import { resolveProject } from '../build/projectRef.js';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const SEVERITY_RANK: Record<QaIssue['severity'], number> = { low: 0, medium: 1, high: 2 };

interface DeterministicResult {
  issues: QaIssue[];
  screenshots: Array<{ name: string; buf: Buffer }>;
  metrics: Record<string, unknown>;
}

/**
 * The §2.4 rubric and the anti-slop ban-list, as the critic sees them.
 *
 * Exported so `scripts/phaseC-critic-check.ts` can exercise the critic against a
 * screenshot directory with the EXACT prompt the pipeline uses — a prompt that
 * drifts from what is tested is a prompt nobody is really testing.
 */
export const VISUAL_CRITIC_SYSTEM_PROMPT = `You are a ruthless independent design critic. You did NOT build this page and have no
stake in defending it. You are looking at full-page screenshots of a private demo site made for
a real local business, which will be shown to its owner.

Score the four rubric axes 0-10 and list CONCRETE, ACTIONABLE issues. "Improve the hierarchy" is
useless; "the H1 at 42px is barely larger than the 32px section headings — take it to
clamp(3.5rem, 8vw, 7rem) and drop the section headings to 24px" is useful.

RUBRIC
- typographicHierarchy: is there real size contrast, or is everything mid-sized? Are micro-labels
  used (uppercase, letterspaced, 11-13px)? Few styles used decisively beats many styles.
- spacingRhythm: do sections vary in height and density deliberately, or is every band the same?
  Is the whitespace confident or is everything cramped/evenly padded?
- photoTreatment: are real photographs given room and cropped well, or squeezed into small equal
  boxes? Is the hero photo-led? Are crops awkward (heads cut, subject dead-centre by accident)?
- motionAppropriateness: judge from what is visible — anything that looks mid-animation, cut off,
  or half-faded in a static screenshot is a defect. On a hero backed by VIDEO, compare its crop
  across the motion frames: the file already pans/zooms, so if the framing ALSO shifts with
  scroll or time beyond that, two motion sources are stacked — file it as high severity
  ("compounded hero motion"), it reads as a shaking background at full speed.

ANTI-SLOP BAN-LIST. Any of these present is an issue with category "slop":
purple/violet-to-blue gradients; gradient text on a headline; three identical cards in a row;
emoji as bullets or section icons; a centred H1 with a centred subtitle and two side-by-side
buttons; every section a full-width band with a centred title; icon grids of unrelated pictograms;
default Inter/Poppins/Montserrat as the display face; neon-on-black startup palette on a beauty
business; text that would read identically for any other business in the world.

Also flag the three looks AI design defaults to REGARDLESS of subject, unless the business's
measured identity genuinely leads there: (1) warm cream (~#F4F1EA) + high-contrast serif +
terracotta accent; (2) near-black + one acid-green/vermilion accent; (3) broadsheet hairline
rules, zero radius, newspaper columns. Landing on one of these without a brand-driven reason
is a "slop" issue: it is a default wearing the business's colours.

THE SIGNATURE TEST. After scoring, answer: what is the ONE element this page would be
remembered by? If you cannot name one — if deleting any single element would lose nothing —
file a high-severity "wow" issue saying exactly that, and name where the signature should
live given this business's world.

The \`desktop-reduced-motion\` screenshot is the SAME page with reduced motion on. Content missing
or invisible there that is present in the normal render is a high-severity issue.

WHAT YOU ARE LOOKING AT. Three kinds of image, all named in the payload:
- \`desktop\` / \`tablet\` / \`mobile\` / \`desktop-reduced-motion\` — full-page screenshots of OUR page.
- \`motion-load-*\` and \`motion-scroll-*\` — viewport frames of OUR page. The five \`motion-load-\`
  frames are the same viewport at 0.15s / 0.8s / 1.6s / 2.4s / 3.6s after load. Two comparisons
  matter: **t0.15s vs t1.60s** (did anything happen at all?) and **t2.40s vs t3.60s** (is the hero
  STILL moving once entrances are over?). A hero that animates in and then freezes is a static
  hero with an entrance — score it accordingly. The six \`motion-scroll-\` frames are the viewport
  at 0/20/40/60/80/100% scroll depth, taken 450ms after arriving — they show whether sections
  arrive with any choreography or all sit identically settled.
- \`reference-hero\` / \`reference-full\` — **NOT our page.** These are the award-winning site the
  art direction was built from. They are the bar, not the subject. Never file an issue about them.

WOW RUBRIC — score \`wow\`, 0-3 on each of six axes (0 absent, 1 token, 2 solid, 3 genuinely
striking). This is the axis set that decides whether the page reads as a real designed site or as
a default AI template, so score what you can SEE, not what the page seems to intend:

${renderWowRubric()}

Code applies the gate, not you. ${renderWowGate()}
Failing it fails the page as "default AI template" regardless of what you set \`approved\` to.
So score honestly and low where it is deserved — inflating a 1 to a 2 to be kind just ships a
page Roman will reject.

CONTRACT VERDICTS — when the payload carries \`motionContract\`, fill \`mechanicVerdicts\`:
one entry per promised mechanic and per sceneMap scene (named "scene:<section>"), verdict
implemented / partial / absent, with the FRAME that proves it as evidence. This is the check
that separates a motion site from a page with entrance effects: a promised scrub or pin you
cannot see across the scroll frames is absent, whatever the code claims. Code turns every
\`absent\` into a high-severity issue automatically — do not also duplicate it in \`issues\`.

REFERENCE COMPARISON — fill \`referenceComparison\`: \`closeness\` 0-10 for how near our page gets
to the reference's level of craft, and \`gap\` naming the single most important thing the
reference does that ours does not. Be specific ("the reference runs one grade over every photo;
ours mixes a warm interior shot with a cold flat-lay"), not general ("less polished").

File wow failures as issues with category "wow" and a fix that names the mechanic to add.

Set approved=true only if there are no high-severity issues, the page clears the wow gate above,
and it would genuinely impress the owner. Be honest rather than kind — an unapproved page just
gets one more iteration.`;

/**
 * Drive every scroll-reveal to its final state before judging or screenshotting.
 *
 * This is not cosmetic. Scroll-triggered reveals (BlurFade `inView`, GSAP
 * ScrollTrigger, IntersectionObserver) only fire for sections that actually enter
 * the viewport. Jumping straight to the bottom fires the LAST section and skips
 * everything between, and a `fullPage: true` screenshot then captures those
 * middle sections still at `opacity: 0` — the critic sees empty bands and files
 * issues against a page that is fine, while a genuinely broken reveal looks the
 * same. Stepping through the page one viewport at a time settles all of them.
 */
async function settlePage(page: import('playwright').Page): Promise<void> {
  await page.waitForTimeout(1500); // entrance animations
  const height = await page.evaluate(() => document.body.scrollHeight);
  const viewport = page.viewportSize()?.height ?? 900;
  const step = Math.max(200, Math.floor(viewport * 0.75));
  for (let y = 0; y < height; y += step) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(260);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  // Long enough for reveal animations started on the way down to finish; they
  // must NOT reverse on scroll-up, and a page that hides content again when
  // scrolled back is itself a defect the screenshot will show.
  await page.waitForTimeout(1200);
}

/**
 * Fraction of hero pixels that must change between t≈0.15s and t≈1.6s for the
 * hero to count as animated.
 *
 * Calibrated to sit above sub-pixel text antialiasing and JPEG-ish noise (which
 * moves well under 0.1% of pixels) and below any real motion: a Ken Burns tween
 * at `scale: 1 → 1.02` over 1.5s already displaces several percent of the frame,
 * and a video hero changes most of it. A cursor blink or a lazy image finishing
 * its decode would not clear this on its own.
 */
const HERO_MOTION_PIXEL_THRESHOLD = 0.015;
/**
 * Sustained motion is measured separately and against a lower bar.
 *
 * The entrance delta (0.15s → 1.6s) catches any first-paint change at all —
 * including a one-shot fade-in of a static block, which is emphatically NOT what
 * "the first screen moves" means. So a second window (2.4s → 3.6s), by which time
 * every entrance has finished, decides whether the hero KEEPS moving. The bar is
 * lower because a slow Ken Burns (`scale: 1 → 1.08` over 15s) displaces only a
 * fraction of a percent in 1.2s, while still being unmistakably alive.
 */
const HERO_SUSTAINED_PIXEL_THRESHOLD = 0.004;
/** Per-pixel channel delta below which two frames are "the same pixel". */
const PIXEL_NOISE_FLOOR = 12;

export interface MotionEvidence {
  /** Frames handed to the critic, in capture order. */
  frames: Array<{ name: string; buf: Buffer; caption: string }>;
  /** Deterministic verdict: did the hero move on its own, without any scrolling? */
  heroMotionDetected: boolean;
  /** Fraction of hero-viewport pixels that changed between the two early frames. */
  heroMotionPixelDelta: number;
  /**
   * Fraction changed between 2.4s and 3.6s — after every entrance has settled.
   * This separates a page that is ALIVE (video, slow zoom, drift) from one that
   * merely faded a static block in once and then froze.
   */
  heroSustainedPixelDelta: number;
  /** True when the hero is still moving after the entrance finishes. */
  heroSustainedMotion: boolean;
  /** DOM evidence of a motion runtime being driven, independent of the pixel test. */
  animationEngines: string[];
  /** Elements carrying a non-identity transform 1.6s after load. */
  transformedAtRest: number;
  /**
   * Per scroll depth (20..100%): fraction of viewport pixels that changed
   * between the moment of arrival and 450ms later. Scroll CHOREOGRAPHY is
   * things still moving as a section arrives; a page whose every depth lands
   * already settled is a static site with entrance effects.
   */
  scrollArrivalDeltas: number[];
  /** True when at least two depths show real arrival motion. */
  scrollChoreographyDetected: boolean;
}

/**
 * Compare two same-size PNG frames and return the fraction of differing pixels.
 *
 * Decoded in the browser via a canvas rather than by adding an image library:
 * Playwright is already here, the frames are already PNGs the page can load, and
 * a native dependency for one subtraction is not worth the install cost.
 */
async function framePixelDelta(page: import('playwright').Page, a: Buffer, b: Buffer): Promise<number> {
  /**
   * Built with `new Function`, not written inline.
   *
   * tsx/esbuild rewrites the named inner helpers this needs (`load`, `draw`) to
   * attach a `__name` bookkeeping call for stack traces. `page.evaluate(fn)`
   * serialises the *transpiled* body, so `__name` travels into the browser where
   * nothing defines it and the call dies with `ReferenceError: __name is not
   * defined`. A `new Function` body is never seen by the transpiler, so it
   * arrives exactly as written. (The other evaluates in this file are safe only
   * because they declare no inner named functions — adding one would break them
   * the same way.)
   *
   * A plain string is NOT an option: Playwright evaluates a string as an
   * expression and drops the argument, which silently returns undefined.
   */
  const fn = new Function('args', `
    const aB64 = args[0], bB64 = args[1], floor = args[2];
    const load = function (b64) {
      return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = 'data:image/png;base64,' + b64;
      });
    };
    return Promise.all([load(aB64), load(bB64)]).then(function (pair) {
      const w = Math.min(pair[0].width, pair[1].width);
      const h = Math.min(pair[0].height, pair[1].height);
      if (w === 0 || h === 0) return 0;
      const draw = function (img) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, w, h).data;
      };
      const da = draw(pair[0]);
      const dbb = draw(pair[1]);
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.abs(da[i] - dbb[i]) + Math.abs(da[i + 1] - dbb[i + 1]) + Math.abs(da[i + 2] - dbb[i + 2]);
        if (d > floor) changed++;
      }
      return changed / (w * h);
    });
  `) as (args: Array<string | number>) => number;

  return page.evaluate(fn, [a.toString('base64'), b.toString('base64'), PIXEL_NOISE_FLOOR]);
}

/**
 * Capture what a still screenshot cannot show: whether the page MOVES.
 *
 * A critic looking only at settled full-page screenshots has no way to tell a
 * scroll-choreographed page from a static one — which is exactly how the demo
 * Roman rejected passed every gate. So we capture:
 *
 *   - three viewport frames on load (t≈0.15s / 0.8s / 1.6s), which show a
 *     preloader, a hero video, or a slow zoom actually happening;
 *   - six frames at 0/20/40/60/80/100% scroll, which show whether sections
 *     arrive with any choreography or all look identically settled.
 *
 * The hero verdict is DETERMINISTIC and does not depend on the critic: the first
 * and third load frames are diffed pixel-by-pixel, and the DOM is queried for a
 * motion runtime (GSAP/ScrollTrigger/Motion) actually driving transforms. Either
 * signal alone is weak — a video hero moves pixels with no GSAP, a pinned section
 * registers ScrollTrigger without the hero moving — so both are recorded and the
 * pixel test is the one that decides.
 *
 * A separate browser context is used because the settle-scroll in
 * `deterministicChecks` has already driven every reveal to its end state.
 */
export async function captureMotionEvidence(
  browser: Browser,
  url: string,
): Promise<MotionEvidence> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const frames: MotionEvidence['frames'] = [];
  try {
    // `domcontentloaded`, not `networkidle`: waiting for the network to go quiet
    // would skip past the preloader and the first second of hero animation, which
    // is the whole thing being measured.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    await page.waitForTimeout(150);
    const t0 = await page.screenshot();
    await page.waitForTimeout(650);
    const t08 = await page.screenshot();
    await page.waitForTimeout(800);
    const t16 = await page.screenshot();

    // Two more frames after everything has settled. An entrance animation is
    // finished by ~2s; anything still changing between these two is real,
    // continuing motion rather than a one-shot reveal.
    await page.waitForTimeout(800);
    const t24 = await page.screenshot();
    await page.waitForTimeout(1200);
    const t36 = await page.screenshot();

    frames.push(
      { name: 'motion-load-t0.15s', buf: t0, caption: 'viewport 0.15s after DOMContentLoaded — preloader, or the hero at its start state' },
      { name: 'motion-load-t0.80s', buf: t08, caption: 'viewport 0.8s after load' },
      { name: 'motion-load-t1.60s', buf: t16, caption: 'viewport 1.6s after load — compare with t0.15s: if these are identical the hero never moved at all' },
      { name: 'motion-load-t2.40s', buf: t24, caption: 'viewport 2.4s after load — every entrance animation has finished by now' },
      { name: 'motion-load-t3.60s', buf: t36, caption: 'viewport 3.6s after load — compare with t2.40s: if these are identical the hero is FROZEN after its entrance, which is not a hero that moves' },
    );

    const heroMotionPixelDelta = await framePixelDelta(page, t0, t16);
    const heroSustainedPixelDelta = await framePixelDelta(page, t24, t36);

    // DOM-side corroboration: is a motion runtime actually driving anything?
    const dom = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      const engines: string[] = [];
      if (w.gsap) engines.push('gsap');
      if (w.ScrollTrigger || w.gsap?.core?.globals?.()?.ScrollTrigger) engines.push('ScrollTrigger');
      if (document.querySelector('[style*="--motion"], [data-framer-appear-id]')) engines.push('motion/react');
      if (document.querySelector('video[autoplay]')) engines.push('video');
      // Elements sitting on a non-identity transform after the entrance settles:
      // the fingerprint of a tween that ran (or is running).
      let transformed = 0;
      for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 3000)) {
        const t = getComputedStyle(el).transform;
        if (t && t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)') transformed++;
      }
      return { engines, transformed };
    });

    // Scroll positions: six evenly-spaced stops, each given a moment to react.
    // Deliberately NOT the settle-scroll of `deterministicChecks` — these frames
    // are meant to show sections mid-arrival, not fully settled.
    const height = await page.evaluate(() => document.body.scrollHeight);
    const viewport = 900;
    const scrollArrivalDeltas: number[] = [];
    for (const pct of [0, 20, 40, 60, 80, 100]) {
      const y = Math.max(0, Math.round(((height - viewport) * pct) / 100));
      await page.evaluate((to) => window.scrollTo({ top: to, behavior: 'instant' as ScrollBehavior }), y);
      // Arrival choreography, measured: the same depth at 0ms vs 450ms. The
      // depth-to-depth comparison would be meaningless (scrolling always moves
      // pixels); WITHIN one depth, change means something is animating in.
      const atArrival = pct === 0 ? null : await page.screenshot();
      await page.waitForTimeout(450);
      const settled = await page.screenshot();
      if (atArrival) {
        scrollArrivalDeltas.push(Number((await framePixelDelta(page, atArrival, settled)).toFixed(4)));
      }
      frames.push({
        name: `motion-scroll-${String(pct).padStart(3, '0')}pct`,
        buf: settled,
        caption: `viewport at ${pct}% scroll depth, 450ms after arriving`,
      });
    }

    const heroSustainedMotion = heroSustainedPixelDelta >= HERO_SUSTAINED_PIXEL_THRESHOLD;
    return {
      frames,
      // BOTH windows must show change. Something has to happen on load, and the
      // hero has to still be moving once the entrance is over — a block that
      // fades in and then freezes is the "static hero" defect wearing a costume.
      heroMotionDetected: heroMotionPixelDelta >= HERO_MOTION_PIXEL_THRESHOLD && heroSustainedMotion,
      heroMotionPixelDelta: Number(heroMotionPixelDelta.toFixed(4)),
      heroSustainedPixelDelta: Number(heroSustainedPixelDelta.toFixed(4)),
      heroSustainedMotion,
      animationEngines: dom.engines,
      transformedAtRest: dom.transformed,
      scrollArrivalDeltas,
      scrollChoreographyDetected: scrollArrivalDeltas.filter((d) => d >= 0.01).length >= 2,
    };
  } finally {
    await ctx.close();
  }
}

/**
 * Everything a browser can prove without an opinion. Returns issues in the same
 * shape as the critic's, so the report and the feedback file are homogeneous.
 *
 * Exported as `runDeterministicChecks` so `scripts/phaseC-qa-only.ts` can run the
 * gates against a workspace without touching the DB or spending an agent call.
 */
export async function deterministicChecks(
  browser: Browser,
  url: string,
  snapshot: BuildSnapshot,
): Promise<DeterministicResult> {
  const issues: QaIssue[] = [];
  const screenshots: Array<{ name: string; buf: Buffer }> = [];
  const metrics: Record<string, unknown> = {};
  const evidencePhotos = realPhotos(snapshot);
  const evidencePhotoFiles = [...new Set(evidencePhotos.flatMap((asset) => [
    asset.file,
    path.basename(asset.file),
    asset.objectKey,
    path.basename(asset.objectKey),
  ]))];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
    page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', (r) => failedRequests.push(`FAILED ${r.url()} (${r.failure()?.errorText ?? '?'})`));

    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    await settlePage(page);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflowing: string[] = [];
      if (doc.scrollWidth > doc.clientWidth + 2) {
        for (const el of Array.from(document.querySelectorAll('*')).slice(0, 4000)) {
          const r = el.getBoundingClientRect();
          if (r.right > doc.clientWidth + 2 || r.left < -2) {
            const tag = el.tagName.toLowerCase();
            const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : '';
            overflowing.push(`${tag}${cls ? `.${cls.split(/\s+/).slice(0, 3).join('.')}` : ''}`);
            if (overflowing.length >= 5) break;
          }
        }
      }
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, culprits: overflowing };
    });
    if (overflow.scrollWidth > overflow.clientWidth + 2) {
      issues.push({
        severity: 'high', category: 'layout', viewport: vp.name,
        issue: `Horizontal overflow at ${vp.width}px: page scrolls to ${overflow.scrollWidth}px in a ${overflow.clientWidth}px viewport.`,
        fix: `Constrain the overflowing element(s)${overflow.culprits.length ? ` — likely ${overflow.culprits.join(', ')}` : ''}. Check for fixed widths, unwrapped long strings, negative margins and full-bleed sections without \`overflow-x: clip\`.`,
      });
    }

    // Images that are visibly distorted relative to their intrinsic aspect ratio.
    const stretched = await page.evaluate(() => {
      const bad: Array<{ src: string; natural: string; rendered: string }> = [];
      for (const img of Array.from(document.images)) {
        if (!img.complete || img.naturalWidth === 0) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        const style = getComputedStyle(img);
        // object-fit handles the crop correctly; only unstyled stretching matters.
        if (style.objectFit === 'cover' || style.objectFit === 'contain') continue;
        const naturalRatio = img.naturalWidth / img.naturalHeight;
        const renderedRatio = r.width / r.height;
        if (Math.abs(naturalRatio - renderedRatio) / naturalRatio > 0.12) {
          bad.push({
            src: img.currentSrc || img.src,
            natural: `${img.naturalWidth}x${img.naturalHeight}`,
            rendered: `${Math.round(r.width)}x${Math.round(r.height)}`,
          });
        }
      }
      return bad.slice(0, 5);
    });
    for (const s of stretched) {
      issues.push({
        severity: 'medium', category: 'photo-treatment', viewport: vp.name,
        issue: `Image ${path.basename(s.src)} is distorted: intrinsic ${s.natural}, rendered ${s.rendered}.`,
        fix: 'Add `object-fit: cover` (or `contain`) with an explicit aspect-ratio box so the photo crops instead of stretching.',
      });
    }

    // ── slop gates ──────────────────────────────────────────────────────────
    // Roman rejected a demo that passed every check above ("дефолтна слоупочна
    // залупа"), so these measure the tells that made it read as machine-made.
    //
    // Measured first, then thresholded: on that page there was NO band without
    // content and the largest true gap was 85px, so "empty bands" was the wrong
    // metric. What was actually wrong is DENSITY — 52 content elements spread
    // over 4691px. Ink coverage per 1000px of page is the honest proxy.
    const slop = await page.evaluate((realPhotoFiles) => {
      const vw = document.documentElement.clientWidth;
      const pageHeight = document.body.scrollHeight;

      // 1. Display text clipped by an overlapping block — reads as a bug, not a crop.
      const clipped: string[] = [];
      for (const el of Array.from(document.querySelectorAll('h1,h2,h3,[class*="wordmark"],[data-wordmark]'))) {
        const text = (el.textContent ?? '').trim();
        if (text.length < 3) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if ((parseFloat(style.fontSize) || 16) < 28) continue; // display scale only
        const overflowsViewport = r.right > vw + 2 || r.left < -2;
        const clippedByBox = el.scrollWidth > Math.ceil(r.width) + 4
          && (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowX === 'clip');
        if (overflowsViewport || clippedByBox) {
          clipped.push(`${el.tagName.toLowerCase()} "${text.slice(0, 40)}"`);
        }
      }

      // 2. Content density. Only leaf text and real media count as "ink" — a
      //    section's background colour is styling, not content.
      let inkElements = 0;
      let textChars = 0;
      let mediaArea = 0;
      let evidenceMediaArea = 0;
      for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 8000)) {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) continue;
        const isLeafText = el.children.length === 0 && (el.textContent ?? '').trim().length > 0;
        const isMedia = ['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(el.tagName)
          || st.backgroundImage.includes('url(');
        if (isLeafText) { inkElements++; textChars += (el.textContent ?? '').trim().length; }
        if (isMedia) {
          inkElements++;
          mediaArea += r.width * r.height;
          let source = st.backgroundImage;
          if (el instanceof HTMLImageElement) source += ` ${el.currentSrc} ${el.src}`;
          if (el instanceof HTMLVideoElement) source += ` ${el.currentSrc} ${el.src} ${el.poster}`;
          if (realPhotoFiles.some((file) => file.length > 0 && source.includes(file))) {
            evidenceMediaArea += r.width * r.height;
          }
        }
      }
      const per1000 = pageHeight > 0 ? (inkElements / pageHeight) * 1000 : 0;

      // 3. Placeholder/template words that survived into the export.
      const bodyText = document.body?.innerText ?? '';
      const placeholders = [...new Set(
        (bodyText.match(/\b(PLACEHOLDER|LOREM IPSUM|TODO|FIXME|SAMPLE TEXT|YOUR TEXT HERE)\b/gi) ?? [])
          .map((m) => m.toUpperCase()),
      )];

      return {
        clipped: clipped.slice(0, 4),
        pageHeight,
        inkElements,
        textChars,
        mediaAreaRatio: Number((mediaArea / Math.max(1, vw * pageHeight)).toFixed(3)),
        evidenceMediaAreaRatio: Number((evidenceMediaArea / Math.max(1, vw * pageHeight)).toFixed(3)),
        inkPer1000px: Number(per1000.toFixed(1)),
        placeholders,
      };
    }, evidencePhotoFiles);

    for (const c of slop.clipped) {
      issues.push({
        severity: 'high', category: 'layout', viewport: vp.name,
        issue: `Display text is clipped: ${c}. A headline cut mid-glyph reads as a rendering bug, not a deliberate crop.`,
        // This gate measures the BOX (viewport overflow OR scrollWidth under
        // overflow:hidden), so it cannot accept an edge-bleed crop — do not
        // promise one. The word must fit or wrap, at every breakpoint.
        fix: 'Size and position the headline so the whole word fits inside the viewport at EVERY breakpoint — a clamp() font-size in vw units, or let it wrap by removing overflow:hidden/clip. A crop that works at 1440 cuts a different letter at 768, so verify in _shots/mobile.png too.',
      });
    }

    issues.push(...evaluateLayoutQuality({
      viewport: vp.name,
      hasRealPhotos: evidencePhotos.length > 0,
      metrics: {
        pageHeight: slop.pageHeight,
        inkElements: slop.inkElements,
        inkPer1000px: slop.inkPer1000px,
        textChars: slop.textChars,
        evidenceMediaAreaRatio: slop.evidenceMediaAreaRatio,
      },
    }));
    if (slop.placeholders.length) {
      issues.push({
        severity: 'high', category: 'content', viewport: vp.name,
        issue: `Placeholder/template words visible in the rendered page: ${slop.placeholders.join(', ')}.`,
        fix: 'Replace with real copy from input/snapshot.json, in the site language. If the snapshot has no content for that slot, delete the slot rather than labelling it.',
      });
    }
    metrics[`${vp.name}.pageHeight`] = slop.pageHeight;
    metrics[`${vp.name}.inkPer1000px`] = slop.inkPer1000px;
    metrics[`${vp.name}.inkElements`] = slop.inkElements;
    metrics[`${vp.name}.textChars`] = slop.textChars;
    metrics[`${vp.name}.pageHeightPerTextChar`] = Number(
      (slop.pageHeight / Math.max(1, slop.textChars)).toFixed(2),
    );
    metrics[`${vp.name}.mediaAreaRatio`] = slop.mediaAreaRatio;
    metrics[`${vp.name}.evidenceMediaAreaRatio`] = slop.evidenceMediaAreaRatio;
    metrics[`${vp.name}.clippedText`] = slop.clipped.length;

    const brokenImages = await page.evaluate(() =>
      Array.from(document.images)
        .filter((i) => i.complete && i.naturalWidth === 0)
        .map((i) => i.currentSrc || i.src).slice(0, 5));
    if (brokenImages.length) {
      issues.push({
        severity: 'high', category: 'photo-treatment', viewport: vp.name,
        issue: `Broken image(s): ${brokenImages.map((b) => path.basename(b)).join(', ')}.`,
        fix: 'Point the src at a file that exists under public/assets/ or public/generated/, or remove the element.',
      });
    }

    if (consoleErrors.length) {
      issues.push({
        severity: 'high', category: 'layout', viewport: vp.name,
        issue: `Console errors at ${vp.width}px: ${consoleErrors.slice(0, 3).join(' | ')}`,
        fix: 'Fix the underlying runtime error. A demo that logs errors is not shippable.',
      });
    }
    if (pageErrors.length) {
      issues.push({
        severity: 'high', category: 'layout', viewport: vp.name,
        issue: `Uncaught page errors at ${vp.width}px: ${pageErrors.slice(0, 3).join(' | ')}`,
        fix: 'Fix the exception; it likely leaves part of the page unrendered.',
      });
    }
    if (failedRequests.length) {
      issues.push({
        severity: 'high', category: 'layout', viewport: vp.name,
        issue: `Failed requests at ${vp.width}px: ${failedRequests.slice(0, 3).join(' | ')}`,
        fix: 'Every asset must resolve from the static export. Remove external requests and fix broken local paths.',
      });
    }

    screenshots.push({ name: vp.name, buf: await page.screenshot({ fullPage: true }) });
    metrics[`${vp.name}.scrollWidth`] = overflow.scrollWidth;
    metrics[`${vp.name}.consoleErrors`] = consoleErrors.length;
    metrics[`${vp.name}.failedRequests`] = failedRequests.length;
    await ctx.close();
  }

  // ── content checks on the desktop render ──────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    await settlePage(page);

    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    const strip = (s: string) => s.replace(/[\s\-().]/g, '');

    // A verified contact must be reachable, not merely present in the DOM.
    const contactHits = snapshot.contacts.filter((c) => {
      if (c.channel === 'phone' || c.channel === 'whatsapp' || c.channel === 'viber') {
        const d = c.value.replace(/\D/g, '');
        return d.length >= 8 && (strip(text).includes(d.slice(-9)) || html.includes(d.slice(-9)));
      }
      return text.toLowerCase().includes(c.value.toLowerCase()) || html.toLowerCase().includes(c.value.toLowerCase());
    });
    if (contactHits.length === 0) {
      issues.push({
        severity: 'high', category: 'content', viewport: 'all',
        issue: `No contact from the snapshot appears on the page. Available: ${snapshot.contacts.map((c) => `${c.channel} ${c.value}`).join(', ') || 'none'}.`,
        fix: 'Add a contact section using a real snapshot contact as a working `tel:`/`mailto:` link, and use it for the primary CTA.',
      });
    }
    metrics.contactsVisible = contactHits.map((c) => `${c.channel}:${c.value}`);

    if (!/name=["']robots["'][^>]*noindex/i.test(html)) {
      issues.push({
        severity: 'high', category: 'content', viewport: 'all',
        issue: 'The rendered page has no robots noindex meta tag.',
        fix: "Restore `robots: { index: false, follow: false }` in the layout metadata. These demos are private.",
      });
    }

    // The business's own name should be on its own site.
    if (!text.toLowerCase().includes(snapshot.name.toLowerCase().split(/\s+/)[0]!.toLowerCase())) {
      issues.push({
        severity: 'high', category: 'content', viewport: 'all',
        issue: `The business name "${snapshot.name}" does not appear in the page text.`,
        fix: 'Show the real business name in the header/hero and in the <title>.',
      });
    }
    metrics.textLength = text.length;
    await ctx.close();
  }

  // ── reduced motion: nothing may be left invisible ─────────────────────────
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    // Under reduced motion every reveal must already be final, but settle anyway:
    // a page that only reveals on scroll even with motion disabled is the bug.
    await settlePage(page);

    const invisible = await page.evaluate(() => {
      const hidden: string[] = [];
      const nodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,li,figcaption,a,button,section,article'));
      for (const el of nodes.slice(0, 3000)) {
        const textContent = (el.textContent ?? '').trim();
        if (textContent.length < 3) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue; // deliberately hidden
        const opacity = Number.parseFloat(style.opacity);
        const rect = el.getBoundingClientRect();
        // opacity 0 with real text is the documented reduced-motion trap.
        if (opacity < 0.05 && rect.width > 0 && rect.height > 0) {
          hidden.push(`${el.tagName.toLowerCase()}: "${textContent.slice(0, 60)}"`);
          if (hidden.length >= 6) break;
        }
      }
      return hidden;
    });
    if (invisible.length) {
      issues.push({
        severity: 'high', category: 'motion-appropriateness', viewport: 'all',
        issue: `With prefers-reduced-motion: reduce, ${invisible.length} element(s) stay invisible (opacity 0): ${invisible.slice(0, 4).join(' | ')}`,
        fix: 'Never leave content at opacity 0 waiting for a cancelled animation. Use `motionSafe()` / `useReducedMotion()` to decide whether to ANIMATE, never whether to RENDER.',
      });
    }
    metrics.reducedMotionInvisible = invisible.length;

    // Screenshot the reduced-motion render too — the critic should see it.
    screenshots.push({ name: 'desktop-reduced-motion', buf: await page.screenshot({ fullPage: true }) });
    await ctx.close();
  }

  return { issues, screenshots, metrics };
}

/**
 * Assemble everything the critic looks at and run it.
 *
 * Split out of the handler so `scripts/phaseC-critic-check.ts` exercises the
 * EXACT payload the pipeline sends — reference stills, motion frames and all. A
 * critic tested on a different payload than it receives is a critic nobody has
 * really tested.
 *
 * Images are written to a scratch directory and the agent Reads them itself
 * (subscription runtime, no base64 API payloads).
 */
export async function runVisualCritique(opts: {
  business: { name: string; category?: string | null; city?: string | null; languageName: string };
  designDirection: string | null;
  /** Chosen motion reference slug; its `hero.jpg`/`full.jpg` become the bar. */
  referenceSlug: string | null;
  /** The promised mechanics and scene map — the contract the verdicts run against. */
  contract?: {
    mechanics: Array<{ name: string; component: string; where: string }>;
    sceneMap: { system: string; scenes: Array<{ section: string; trigger: string; motion: string; handoff: string }> } | null;
  };
  screenshots: Array<{ name: string; buf: Buffer }>;
  motion: MotionEvidence | null;
  onUsage?: (usage: import('../agents/types.js').AgentUsage) => void;
  /** Project's live build log; the critic's own turns are traced into it too. */
  buildLogPath?: string;
}): Promise<import('../build/schemas.js').VisualCritique> {
  const shotDir = await createAgentInputWorkspace('factory-qa-');
  try {
    const imagePaths: string[] = [];
    const inventory: Array<{ image: string; what: string }> = [];

    for (const s of opts.screenshots) {
      const f = path.join(shotDir, `${s.name}.png`);
      await writeFile(f, s.buf);
      imagePaths.push(f);
      inventory.push({ image: s.name, what: 'full-page screenshot of OUR page' });
    }
    for (const f of opts.motion?.frames ?? []) {
      const p = path.join(shotDir, `${f.name}.png`);
      await writeFile(p, f.buf);
      imagePaths.push(p);
      inventory.push({ image: f.name, what: f.caption });
    }

    // The reference stills, copied in LAST so their names sort clearly apart.
    let referenceAttached = false;
    if (opts.referenceSlug) {
      const refDir = motionRefDir(opts.referenceSlug);
      for (const [file, alias, what] of [
        ['hero.jpg', 'reference-hero', 'the REFERENCE site above the fold — the bar, not our page'],
        ['full.jpg', 'reference-full', 'the REFERENCE site full-page — the bar for section rhythm'],
      ] as const) {
        const from = path.join(refDir, file);
        if (!existsSync(from)) continue;
        const to = path.join(shotDir, `${alias}.jpg`);
        await copyFile(from, to);
        imagePaths.push(to);
        inventory.push({ image: alias, what: `${what} (${opts.referenceSlug})` });
        referenceAttached = true;
      }
    }
    if (opts.referenceSlug && !referenceAttached) {
      log.warn('motion reference stills not found; critic has no bar to compare against', {
        slug: opts.referenceSlug,
      });
    }

    return await runAgent(
      'visual-critique',
      VISUAL_CRITIC_SYSTEM_PROMPT,
      JSON.stringify({
        business: opts.business,
        designDirection: opts.designDirection,
        referenceSlug: opts.referenceSlug ?? '(none — score referenceComparison.closeness 0 and say so in gap)',
        images: inventory,
        motionContract: opts.contract && (opts.contract.mechanics.length || opts.contract.sceneMap)
          ? {
              mechanics: opts.contract.mechanics,
              sceneMap: opts.contract.sceneMap,
              note: 'Fill mechanicVerdicts with ONE entry per mechanic above and per sceneMap scene '
                + '(name scenes as "scene:<section>"). Judge from the motion frames; an entry you '
                + 'cannot point at a frame for is absent, not implemented.',
            }
          : null,
        deterministicMotionSignals: opts.motion
          ? {
              heroMotionDetected: opts.motion.heroMotionDetected,
              entrancePixelsChanged_0_15s_to_1_6s: opts.motion.heroMotionPixelDelta,
              sustainedPixelsChanged_2_4s_to_3_6s: opts.motion.heroSustainedPixelDelta,
              heroStillMovingAfterEntrance: opts.motion.heroSustainedMotion,
              animationEngines: opts.motion.animationEngines,
              transformedElementsAtRest: opts.motion.transformedAtRest,
              scrollArrivalPixelDeltas_perDepth: opts.motion.scrollArrivalDeltas,
              scrollChoreographyDetected: opts.motion.scrollChoreographyDetected,
              note: 'Measured by the browser, not by you. If heroMotionDetected is false, heroMotion cannot score above 0 — a hero that fades in once and then freezes counts as static.',
            }
          : null,
        note: 'The desktop/tablet/mobile images are full-page. Judge composition, not the fold.',
      }, null, 2),
      VisualCritiqueSchema,
      {
        kind: 'visual-critique', heavy: true, imagePaths, cwd: shotDir,
        timeoutMs: 15 * 60_000,
        onUsage: opts.onUsage,
        buildLogPath: opts.buildLogPath,
      },
    );
  } finally {
    await rm(shotDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Merge issues that differ only by the viewport that measured them.
 * Same text = same problem; the viewports it failed on are part of the answer,
 * not extra problems. First severity/category wins (they are identical anyway).
 */
export function dedupeIssues(issues: QaIssue[]): QaIssue[] {
  const byText = new Map<string, QaIssue>();
  for (const issue of issues) {
    const seen = byText.get(issue.issue);
    if (!seen) {
      byText.set(issue.issue, { ...issue });
      continue;
    }
    if (!seen.viewport.split('+').includes(issue.viewport)) {
      seen.viewport = `${seen.viewport}+${issue.viewport}`;
    }
  }
  return [...byText.values()];
}

/** Render the issue list as the markdown the builder agent reads next iteration. */
function renderQaIssues(issues: QaIssue[], iteration: number, snapshot: BuildSnapshot): string {
  const bySeverity = (s: QaIssue['severity']) => issues.filter((i) => i.severity === s);
  const section = (title: string, list: QaIssue[]) => list.length
    ? `## ${title}\n\n${list.map((i, n) =>
        `### ${n + 1}. [${i.category} @ ${i.viewport}] ${i.issue}\n\n**Fix:** ${i.fix}\n`).join('\n')}`
    : '';

  return `# QA issues — iteration ${iteration}

Automated QA ran against your build of the demo for **${snapshot.name}**.
Fix these and only these. Everything not listed here passed and must not be redesigned.

Deterministic checks ran in a real browser at 390 / 768 / 1440 and with
\`prefers-reduced-motion: reduce\`. The visual critique came from an independent
reviewer looking at the screenshots. Provenance findings come from grepping your
exported HTML against \`input/snapshot.json\`.

${section('High severity — these block the demo', bySeverity('high'))}
${section('Medium severity', bySeverity('medium'))}
${section('Low severity (fix if cheap)', bySeverity('low'))}

When done: \`pnpm build\` green, \`out/index.html\` present, then write \`result.json\`.
`;
}

/**
 * The motion reference slug the chosen art direction named, out of the frozen
 * design contract. Returns null (never throws) when the contract predates the
 * motion pack or the object is gone — the critic is then told there is no bar
 * rather than being shown the wrong one.
 */
interface ContractMotionInfo {
  referenceSlug: string | null;
  /** The promised mechanics, verbatim from the contract, for per-name verdicts. */
  mechanics: Array<{ name: string; component: string; where: string }>;
  /** The scene map (contracts v2+); older contracts never reach QA — the builder regenerates them. */
  sceneMap: { system: string; scenes: Array<{ section: string; trigger: string; motion: string; handoff: string }> } | null;
}

async function loadDesignContractInfo(designContractKey: string | null): Promise<ContractMotionInfo> {
  const empty: ContractMotionInfo = { referenceSlug: null, mechanics: [], sceneMap: null };
  if (!designContractKey) return empty;
  try {
    const contract = JSON.parse((await getObject('raw', designContractKey)).toString());
    const chosen = contract?.chosen ?? {};
    const slug = chosen.referenceSlug;
    return {
      referenceSlug: typeof slug === 'string' && slug.length > 0 ? slug : null,
      mechanics: Array.isArray(chosen.mechanics) ? chosen.mechanics : [],
      sceneMap: chosen.sceneMap && Array.isArray(chosen.sceneMap.scenes) ? chosen.sceneMap : null,
    };
  } catch (err) {
    log.warn('could not read design contract for QA', {
      designContractKey, err: String(err).slice(0, 200),
    });
    return empty;
  }
}

export async function visualQaHandler(payload: JobPayload): Promise<void> {
  const startedAt = Date.now();
  const businessId = payload.businessId!;
  const project = await resolveProject('visualQa', payload);
  const projectId = project.id;
  const iteration = (payload.iteration as number | undefined) ?? 0;



  // Judge the site against the snapshot it was BUILT from, not a newer one.
  const snapshot: BuildSnapshot = project.snapshotKey
    ? JSON.parse((await getObject('raw', project.snapshotKey)).toString())
    : await buildSnapshot(businessId);

  const dir = project.dir || path.resolve('sites', businessId, String(projectId));
  const logPath = buildLogPath(businessId);
  await logStage(logPath, `Перевірка сторінки, ітерація ${iteration + 1}: відкриваю в браузері`, 'visual-qa');
  const serveRoot = outputDir(dir);
  const { url, close } = await serveDir(serveRoot);

  const issues: QaIssue[] = [];
  const screenshotKeys: string[] = [];
  let metrics: Record<string, unknown> = {};
  let critiqueResult: unknown = null;

  // Provenance issues found by the builder's code-side check ride along.
  for (const text of (payload.provenanceIssues as string[] | undefined) ?? []) {
    // A hand-made derivative (e.g. gallery-…-crop.jpg written into public/
    // assets/) is the one recurring unknown-asset case, and the generic
    // "remove the fabrication" hint does not tell the agent what IS allowed:
    // crop with CSS on the original file, never write new files into assets.
    const isUnknownAsset = text.includes('not a snapshot asset');
    issues.push({
      severity: 'high', category: 'content', viewport: 'all',
      issue: text,
      fix: isUnknownAsset
        ? 'Reference the ORIGINAL snapshot asset (copy the exact filename from input/snapshot.json / public/assets/). If you need a cropped or tinted variant, produce it with CSS (object-fit, clip-path, filters) on the original — writing a new image file into public/assets/ will fail this check again.'
        : 'Remove the fabricated detail. Only values present in `input/snapshot.json` may appear on the page.',
    });
  }

  // The art direction this build was supposed to implement, for the reference
  // stills and the wow comparison. A project built before the motion pack landed
  // simply has no slug, and the critic is told so rather than shown a wrong bar.
  const contractInfo = await loadDesignContractInfo(project.designContractKey);
  const referenceSlug = contractInfo.referenceSlug;

  const browser = await chromium.launch({ headless: true });
  let screenshots: Array<{ name: string; buf: Buffer }> = [];
  let motion: MotionEvidence | null = null;
  let wowScores: Record<string, number> | null = null;
  let wow: { total: number; ambition: number; passed: boolean; reasons: string[] } | null = null;
  try {
    const det = await deterministicChecks(browser, url, snapshot);
    issues.push(...det.issues);
    screenshots = det.screenshots;
    metrics = det.metrics;
    await logStage(
      logPath,
      `Технічні перевірки (390/768/1440 + без анімацій): ${det.issues.length} зауваж.`,
      'visual-qa',
    );

    // ── motion evidence ─────────────────────────────────────────────────────
    // Deterministic, and captured whether or not the critic later runs: a static
    // hero is a defect the browser can prove on its own.
    try {
      motion = await captureMotionEvidence(browser, url);
      metrics.heroMotionDetected = motion.heroMotionDetected;
      metrics.heroMotionPixelDelta = motion.heroMotionPixelDelta;
      metrics.heroSustainedPixelDelta = motion.heroSustainedPixelDelta;
      metrics.heroSustainedMotion = motion.heroSustainedMotion;
      metrics.animationEngines = motion.animationEngines;
      metrics.transformedAtRest = motion.transformedAtRest;
      metrics.scrollArrivalDeltas = motion.scrollArrivalDeltas;
      metrics.scrollChoreographyDetected = motion.scrollChoreographyDetected;
      if (!motion.scrollChoreographyDetected) {
        issues.push({
          severity: 'medium', category: 'wow', viewport: 'desktop',
          issue: `No scroll choreography measured: at every scroll depth the viewport was already settled on arrival `
            + `(arrival deltas: ${motion.scrollArrivalDeltas.join(', ')}). This is a static page with entrance effects.`,
          fix: 'Give at least two sections real arrival or scrub motion (ScrollTrigger scrub/pin, staged reveals) per the scene map — and verify in `pnpm shot --motion` frames.',
        });
      }
      if (!motion.heroMotionDetected) {
        // Two distinct failures with the same verdict, and the fix differs, so
        // the message says which one happened.
        const entranceOnly = motion.heroMotionPixelDelta >= HERO_MOTION_PIXEL_THRESHOLD;
        issues.push({
          severity: 'high', category: 'wow', viewport: 'desktop',
          issue: entranceOnly
            ? `The hero animates once and then freezes: ${(motion.heroMotionPixelDelta * 100).toFixed(2)}% of pixels changed during the entrance (0.15s→1.6s), but only ${(motion.heroSustainedPixelDelta * 100).toFixed(2)}% between 2.4s and 3.6s (threshold ${(HERO_SUSTAINED_PIXEL_THRESHOLD * 100).toFixed(1)}%). A block that fades in once and then sits perfectly still is a static hero with an entrance, not a first screen that moves.`
            : `The hero does not move at all: only ${(motion.heroMotionPixelDelta * 100).toFixed(2)}% of pixels changed between 0.15s and 1.6s after load (threshold ${(HERO_MOTION_PIXEL_THRESHOLD * 100).toFixed(1)}%). A first screen identical a second and a half after it loads is the defect that got the previous demo rejected.`,
          fix: entranceOnly
            ? 'Keep the entrance, but give the first screen motion that CONTINUES: a slow Ken Burns on the real hero photograph (`KenBurnsImage`, scale 1 → 1.08 over 15-20s) or a looping muted video with a poster (`VideoHero`). Under reduced motion it renders perfectly static — that branch is separate and still required.'
            : 'Give the first screen motion tied to its content: a Ken Burns slow zoom on the real hero photograph (`KenBurnsImage`), a looping muted video with a poster (`VideoHero`), or a scroll-linked mask reveal (`MaskWipe`). See the mechanics list in BUILD-TASK.md — the art direction already names which one.',
        });
      }
      log.info('motion evidence captured', {
        businessId, iteration, frames: motion.frames.length,
        heroMotionDetected: motion.heroMotionDetected,
        entranceDelta: motion.heroMotionPixelDelta,
        sustainedDelta: motion.heroSustainedPixelDelta,
        engines: motion.animationEngines,
      });
    } catch (err) {
      // Losing the motion frames must not fail the job; the stills still carry QA.
      log.warn('motion evidence capture failed; critic sees stills only', {
        businessId, iteration, err: String(err).slice(0, 300),
      });
    }

    for (const s of [...screenshots, ...(motion?.frames ?? [])]) {
      screenshotKeys.push(await putRaw(`sites/${businessId}/qa-${iteration}/${s.name}`, s.buf, 'image/png'));
    }

    // ── multimodal critique ─────────────────────────────────────────────────
    await logStage(logPath, 'Дизайн-критик дивиться скриншоти', 'visual-qa');
    try {
      const critique = await runVisualCritique({
        buildLogPath: logPath,
        business: {
          name: snapshot.name, category: snapshot.category, city: snapshot.city,
          languageName: snapshot.languageName,
        },
        designDirection: project.designDirection,
        referenceSlug,
        contract: { mechanics: contractInfo.mechanics, sceneMap: contractInfo.sceneMap },
        screenshots,
        motion,
        onUsage: (u) => log.info('agent usage', { businessId, iteration, call: 'visual-critique', ...u }),
      });
      critiqueResult = critique;

      // ── the wow gate ──────────────────────────────────────────────────────
      // CODE decides, not the critic: its `approved` flag is advisory, the six
      // axes are the input, and a hero the browser measured as static cannot be
      // scored above 0 however generous the critic felt.
      wowScores = { ...critique.wow };
      if (motion && !motion.heroMotionDetected) wowScores.heroMotion = 0;
      wow = wowVerdict(wowScores);
      metrics.wowTotal = wow.total;
      metrics.wowPassed = wow.passed;
      metrics.referenceCloseness = critique.referenceComparison.closeness;

      if (!wow.passed) {
        issues.push({
          severity: 'high', category: 'wow', viewport: 'all',
          issue: `Wow gate failed: ${wow.total}/${WOW_MAX} total, ${wow.ambition}/15 design ambition. ${wow.reasons.join('; ')}. `
            + `Axes: ${Object.entries(wowScores).map(([k, v]) => `${k} ${v}/3`).join(', ')}. `
            + `Against the reference "${critique.referenceComparison.slug || referenceSlug || 'n/a'}" the critic scored closeness `
            + `${critique.referenceComparison.closeness}/10: ${critique.referenceComparison.gap}`,
          fix: 'This reads as a default AI template, which is a rejection, not a nitpick. Raise the lowest axes first — implement the mechanics BUILD-TASK.md names, with the components it names. Do not add more sections; make the ones that exist move and be typeset like the reference.',
        });
      }

      // The contract check (MOTION-PLAN phase 4): every promised mechanic or
      // scene the critic could not SEE becomes a named, actionable issue.
      for (const v of critique.mechanicVerdicts ?? []) {
        if (v.verdict === 'implemented') continue;
        issues.push({
          severity: v.verdict === 'absent' ? 'high' : 'medium',
          category: 'wow', viewport: 'all',
          issue: `Contract ${v.verdict}: «${v.name}» — ${v.evidence}`,
          fix: v.verdict === 'absent'
            ? `Implement «${v.name}» exactly as the scene map / mechanics list in BUILD-TASK.md specifies, then verify it in \`pnpm shot --motion\` frames before handing in.`
            : `Finish «${v.name}»: it reads as started but not delivered. Check it against the reference notes and your own motion frames.`,
        });
      }

      const threshold = SEVERITY_RANK[config.build.qaFeedbackSeverity];
      const actionable = critique.issues.filter((i) => SEVERITY_RANK[i.severity] >= threshold);
      issues.push(...actionable);
      log.info('visual critique done', {
        businessId, iteration, approved: critique.approved,
        rubric: critique.rubric, wow: `${wow.total}/${WOW_MAX}`, wowPassed: wow.passed,
        referenceCloseness: critique.referenceComparison.closeness,
        issues: critique.issues.length, actionable: actionable.length,
      });
    } catch (err) {
      // A critic failure must not silently pass a bad page, but it also must not
      // fail the job: the deterministic gates still hold — including the hero
      // motion check above, which needs no model at all.
      log.warn('visual critique failed; deterministic checks stand alone', {
        businessId, iteration, err: String(err).slice(0, 300),
      });
    }
  } finally {
    await browser.close();
    close();
  }

  // ── report ────────────────────────────────────────────────────────────────

  // The deterministic gates run per viewport, so one broken headline arrives
  // three times with byte-identical text. Roman reads «8 зауважень» as eight
  // different problems and the agent re-reads the same instruction three times
  // in QA-ISSUES.md — neither is true. Merge identical texts, naming every
  // viewport that saw it; the raw per-viewport rows stay in the JSON report.
  const deduped = dedupeIssues(issues);
  issues.length = 0;
  issues.push(...deduped);

  const blocking = issues.filter((i) => i.severity === 'high' || i.severity === 'medium');
  const report = {
    iteration,
    businessId,
    projectId,
    at: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    designDirection: project.designDirection,
    passed: blocking.length === 0,
    metrics,
    issues,
    provenanceFindings: payload.provenanceFindings ?? [],
    builderNotes: payload.buildNotes ?? null,
    builderUnresolved: payload.unresolved ?? [],
    critique: critiqueResult,
    wow: wow && wowScores ? { ...wow, axes: wowScores } : null,
    motion: motion
      ? {
          heroMotionDetected: motion.heroMotionDetected,
          heroMotionPixelDelta: motion.heroMotionPixelDelta,
          heroSustainedPixelDelta: motion.heroSustainedPixelDelta,
          heroSustainedMotion: motion.heroSustainedMotion,
          animationEngines: motion.animationEngines,
          transformedAtRest: motion.transformedAtRest,
          scrollArrivalDeltas: motion.scrollArrivalDeltas,
          scrollChoreographyDetected: motion.scrollChoreographyDetected,
          frames: motion.frames.map((f) => f.name),
        }
      : null,
    referenceSlug,
    screenshotKeys,
  };
  const qaReportKey = await putRaw(
    `sites/${businessId}/qa-${iteration}/report`,
    JSON.stringify(report, null, 2),
    'application/json',
  );

  const reportKeys = [...(project.qaReportKeys ?? []), qaReportKey];
  const qaProjectPatch = {
    qaIterations: iteration + 1,
    qaReportKey,
    qaReportKeys: reportKeys,
    screenshotKeys,
    openIssues: issues.map((i) =>
      `[${i.severity}/${i.category}] ${i.issue}${i.viewport.includes('+') ? ` (on ${i.viewport})` : ''}`
    ),
    // The design-side estimate is preserved; only the QA half is rewritten, so
    // the UI can show promised-vs-delivered rather than one number replacing another.
    wowScores: {
      ...(project.wowScores ?? {}),
      ...(wow && wowScores
        ? {
            qa: {
              iteration,
              total: wow.total,
              ambition: wow.ambition,
              passed: wow.passed,
              reasons: wow.reasons,
              axes: wowScores,
              heroMotionDetected: motion?.heroMotionDetected,
              heroMotionPixelDelta: motion?.heroMotionPixelDelta,
              heroSustainedPixelDelta: motion?.heroSustainedPixelDelta,
              referenceCloseness: (critiqueResult as { referenceComparison?: { closeness: number } } | null)
                ?.referenceComparison?.closeness,
            },
          }
        : {}),
    },
  };

  log.info('QA pass complete', {
    businessId, iteration, total: issues.length, blocking: blocking.length,
    seconds: report.durationSeconds, key: qaReportKey,
  });

  // ── verdict ───────────────────────────────────────────────────────────────
  if (blocking.length === 0) {
    await logStage(logPath, 'Перевірка пройдена — публікую демо', 'visual-qa');
    let handedOff = false;
    await commitWorkflow(async (tx) => {
      const [updated] = await tx.update(schema.siteProjects)
        .set({ ...qaProjectPatch, state: 'ready' })
        .where(and(
          eq(schema.siteProjects.id, projectId),
          eq(schema.siteProjects.state, 'qa'),
          eq(schema.siteProjects.qaIterations, iteration),
        ))
        .returning({ id: schema.siteProjects.id });
      if (!updated) return [];
      handedOff = true;
      return [{
        name: 'deploy-demo',
        payload: {
          businessId,
          projectId,
          campaignId: payload.campaignId,
          idempotencyKey: `deploy-demo:${businessId}:${projectId}`,
        },
      }];
    });
    if (!handedOff) {
      log.info('stale visual QA pass ignored: project already advanced', { businessId, projectId });
      throw new JobSkippedError(`Проєкт ${projectId} уже перейшов далі — вердикт перевірки не застосовано.`);
    }
    return;
  }

  // Phase 5 (MOTION-PLAN): a page whose ONLY remaining blockers are motion/wow
  // gets one extra round — those fixes are small, targeted and cheap compared
  // to parking a finished layout on Roman's desk over choreography.
  const motionOnly = blocking.every((i) => i.category === 'motion-appropriateness' || i.category === 'wow');
  const iterationCap = config.maxQaIterations + (motionOnly ? 1 : 0);
  if (iteration + 1 >= iterationCap) {
    await logStage(
      logPath,
      `Ліміт ${iterationCap} ітерацій вичерпано, ${blocking.length} проблем лишилось — чекає на Романа`,
      'visual-qa',
    );
    const parked = await parkBuildForHumanReview({
      projectId,
      businessId,
      reason: `QA limit (${iterationCap}) reached with ${blocking.length} open issues`,
      projectPatch: qaProjectPatch,
    });
    if (!parked) {
      log.info('stale visual QA verdict ignored: project or business already advanced', {
        businessId,
        projectId,
      });
      throw new JobSkippedError(`Проєкт ${projectId} або бізнес уже перейшли далі — вердикт перевірки не застосовано.`);
    }
    // Decision #9: every Telegram push links into the control UI; Telegram has
    // no controls of its own.
    await notifyTelegram(
      `🔍 Демо для <b>${snapshot.name}</b> потребує людини після ${config.maxQaIterations} QA-ітерацій.\n` +
      `Відкриті проблеми:\n${blocking.slice(0, 6).map((i) => `• [${i.severity}] ${i.issue.slice(0, 140)}`).join('\n')}\n\n` +
      `👉 <a href="${uiLinks.business(businessId)}">Відкрити картку бізнесу</a>`,
    ).catch(() => {});
    // Terminal for the automated pipeline: reclaim the build artefacts. Sources
    // and QA reports stay so a human can inspect what went wrong.
    await collectWorkspaceGarbage(dir, 'needs_human_review').catch(() => {});
    // NEEDS_HUMAN: the queue parks it without a retry storm (SPEC §7).
    throw new NeedsHumanError(
      `visual QA exhausted ${config.maxQaIterations} iterations for ${businessId}; ${blocking.length} issues remain`,
    );
  }

  // Feed the issues back into the SAME workspace and let the builder iterate.
  await logStage(
    logPath,
    `${blocking.length} проблем — повертаю агенту на ітерацію ${iteration + 2} з ${config.maxQaIterations}`,
    'visual-qa',
  );
  await writeQaIssues(dir, renderQaIssues(issues, iteration + 1, snapshot));
  let handedOff = false;
  await commitWorkflow(async (tx) => {
    const [updated] = await tx.update(schema.siteProjects)
      .set(qaProjectPatch)
      .where(and(
        eq(schema.siteProjects.id, projectId),
        eq(schema.siteProjects.state, 'qa'),
        eq(schema.siteProjects.qaIterations, iteration),
      ))
      .returning({ id: schema.siteProjects.id });
    if (!updated) return [];
    handedOff = true;
    return [{
      name: 'build-site',
      payload: {
        businessId,
        projectId,
        campaignId: payload.campaignId,
        iteration: iteration + 1,
        issues: issues.map((issue) => `[${issue.severity}/${issue.category}] ${issue.issue} → ${issue.fix}`),
        idempotencyKey: `build-site:${businessId}:${projectId}:${iteration + 1}`,
      },
    }];
  });
  log.info(
    handedOff ? 'QA issues fed back to builder' : 'stale visual QA result ignored',
    { businessId, iteration: iteration + 1, issues: blocking.length },
  );
  if (!handedOff) {
    throw new JobSkippedError(`Проєкт ${projectId} уже змінив стан — зауваження перевірки не передані агенту.`);
  }
}

/** Public alias for tooling; the loop above uses the local name. */
export { deterministicChecks as runDeterministicChecks };
