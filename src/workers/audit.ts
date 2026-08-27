/**
 * Stage 6 — website audit (spec §4).
 *
 * A verdict is only trustworthy if we actually tried every reasonable endpoint:
 * one TLS error on https://www must not become "no website" (the Get Nailed
 * lesson). So we probe the full matrix http/https x www/non-www, then render the
 * best endpoint in a real browser at desktop AND mobile and store both
 * screenshots as evidence.
 *
 * The render is deliberately patient. `domcontentloaded` plus a fixed wait is a
 * lie about a JS-heavy site: it screenshots and measures a page that has not
 * painted yet, and the audit then reports what it saw as fact. So the browser
 * waits for the page to STOP being empty (`settleContent`) before anything is
 * measured or captured, and `broken` requires a page that is dead by several
 * measures at once, never thin text alone (`decideVerdict`).
 *
 * A catalog/booking/social profile is NOT an owned website (spec §5 invariant):
 * `businesses.domain` is null for those, so they audit as `no_website` — the
 * profile itself is recorded as a CONTACT, not as a separate verdict
 * (Roman's decision 2026-08-19: `social_only` merged into `no_website`, because
 * social discovery now fills contacts for everyone, so the split said nothing).
 */
import type { Page } from 'playwright';
import { chromium } from 'playwright';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { putRaw } from '../lib/storage.js';
import {
  businessTransitions,
  canContinueAfterTransition,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { enqueue, type JobPayload } from '../orchestrator/queue.js';
import { log } from '../lib/logger.js';
import { classifySocialUrl, cleanProfileUrl } from '../enrichment/messengers.js';

/**
 * The five verdicts (spec §4 stage 6: "вердикт з 5 значень").
 * Ordered worst-opportunity to best-existing-site.
 */
export const AUDIT_VERDICTS = [
  'no_website',                 // nothing of their own: no site, or only an
                                // Instagram/Facebook/booking/catalog profile
  'broken',                     // a domain exists but no endpoint renders
  'working_with_https_issue',   // renders, but TLS is broken/absent
  'outdated',                   // renders over https, but dated/not responsive
  'working_good',               // modern, responsive, no obvious opportunity
] as const;
export type Verdict = typeof AUDIT_VERDICTS[number];

interface EndpointResult {
  url: string; status: number | null; finalUrl: string | null; tlsOk: boolean | null; error: string | null;
}

/** HEAD-then-GET probe. A 405/501 on HEAD is common, so failure falls back to GET. */
async function probe(url: string): Promise<EndpointResult> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    return { url, status: res.status, finalUrl: res.url, tlsOk: url.startsWith('https') ? true : null, error: null };
  } catch (err: unknown) {
    const e = err as { cause?: { code?: string }; message?: string };
    const msg = String(e?.cause?.code ?? e?.message ?? err);
    const tlsIssue = /CERT|TLS|SSL|EPROTO|HANDSHAKE|SELF_SIGNED|ALT_NAME/i.test(msg);
    return { url, status: null, finalUrl: null, tlsOk: url.startsWith('https') ? (tlsIssue ? false : null) : null, error: msg.slice(0, 200) };
  }
}

/**
 * Modernity probe. Passed as a STRING: tsx/esbuild's `keepNames` injects a
 * `__name` helper into closures, which is undefined once Playwright ships the
 * function into the page ("ReferenceError: __name is not defined").
 */
const MODERN_JS = `(() => {
  const genEl = document.querySelector('meta[name="generator"]');
  const gen = (genEl && genEl.content) || '';
  const viewportEl = document.querySelector('meta[name="viewport"]');
  // Same measurement as TEXT_LENGTH_JS: innerText alone under-reports any page
  // that animates its content in, which is what called two live salon sites
  // empty. Kept inline rather than shared because both probes are shipped into
  // the page as strings.
  const renderedLen = ((document.body && document.body.innerText) || '').trim().length;
  let markupLen = 0;
  if (document.body) {
    const clone = document.body.cloneNode(true);
    const noise = clone.querySelectorAll('script,style,noscript,template');
    for (let i = 0; i < noise.length; i++) noise[i].remove();
    markupLen = (clone.textContent || '').replace(/\\s+/g, ' ').trim().length;
  }
  let layoutTables = 0;
  const tables = document.querySelectorAll('table');
  for (let i = 0; i < tables.length; i++) {
    if (!tables[i].querySelector('th')) layoutTables++;
  }
  return {
    generator: gen,
    datedGenerator: /wordpress [1-4]\\.|joomla ?[12]|frontpage|dreamweaver|wix.*201[0-5]/i.test(gen),
    hasViewport: !!viewportEl,
    hasFlash: !!document.querySelector('object[type*="flash"], embed[type*="flash"], object[classid]'),
    layoutTables: layoutTables,
    textLength: Math.max(renderedLen, markupLen),
    imageCount: document.images.length,
    hasResponsiveCss: (function () {
      try {
        for (let i = 0; i < document.styleSheets.length; i++) {
          const sheet = document.styleSheets[i];
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          if (!rules) continue;
          for (let j = 0; j < rules.length; j++) {
            if (rules[j].type === 4) return true;
          }
        }
      } catch (e) {}
      return false;
    })(),
    title: document.title || ''
  };
})()`;

interface ModernSignals {
  generator: string; datedGenerator: boolean; hasViewport: boolean; hasFlash: boolean;
  layoutTables: number; textLength: number; imageCount: number; hasResponsiveCss: boolean; title: string;
}

/**
 * Content-settle budget. Roman's TRENDY HAIR case (2026-08-20): a live
 * WordPress/Elementor shop whose first byte takes ~3s and whose text is painted
 * by JS afterwards. The old code waited `domcontentloaded` + a fixed 2.5s,
 * measured 54 characters and called it `broken` — a working site classified as
 * "no site", which put it under «Без сайту» and started a demo build for it.
 *
 * So the audit waits for the page to STOP being empty rather than for a fixed
 * number of seconds, and gives up only after a budget that a real visitor would
 * also have exhausted.
 */
const SETTLE_MIN_TEXT = 300;      // "has content" bar; below this we keep waiting
const SETTLE_MAX_MS = 20_000;     // total budget for content to appear
const SETTLE_STEP_MS = 2_000;
const NETWORK_IDLE_MS = 10_000;   // its own timeout: many sites never go idle
const SLOW_RENDER_MS = 6_000;     // above this the slowness itself is a finding

/**
 * How much text the page actually carries.
 *
 * `innerText` alone is NOT that number, and believing it is the second half of
 * the TRENDY HAIR misclassification (2026-08-20). `innerText` reports only what
 * is RENDERED, so on any site that animates its content in — every Elementor /
 * WPBakery theme in this campaign — everything still `visibility:hidden` or
 * mid-transition counts as zero. Measured on the real sites:
 *
 *   ionikolaou.gr   innerText   250  vs textContent 27_708  (18 <p>, 55 links)
 *   trendyhair.gr   innerText    94  vs textContent 31_669  (36 links)
 *
 * Both are content-rich sites that `innerText` called empty. `textContent`
 * ignores styling and counts what is in the DOM, which is the honest answer to
 * "does this page have content"; script and style bodies are excluded so a
 * bundle inlined into the page cannot inflate it. The larger of the two is
 * taken so a page that renders more than its markup (CSS-generated content)
 * is not penalised either.
 */
const TEXT_LENGTH_JS = `(() => {
  const body = document.body;
  if (!body) return 0;
  const rendered = (body.innerText || '').trim().length;
  const clone = body.cloneNode(true);
  const noise = clone.querySelectorAll('script,style,noscript,template');
  for (let i = 0; i < noise.length; i++) noise[i].remove();
  const markup = (clone.textContent || '').replace(/\\s+/g, ' ').trim().length;
  return Math.max(rendered, markup);
})()`;

/**
 * Consent-banner cleanup. Best effort ONLY: a banner that will not close is a
 * cosmetic problem with the screenshot, never a reason to fail an audit or to
 * change a verdict, so every step swallows its own error.
 */
const HIDE_OVERLAYS_JS = `(() => {
  let hidden = 0;
  const nodes = document.querySelectorAll('div,section,aside,dialog,iframe');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const id = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
    if (!/cookie|gdpr|consent|cmp|privacy-?banner/.test(id)) continue;
    let pos = '';
    try { pos = window.getComputedStyle(el).position; } catch (e) {}
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    el.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  // Some CMPs lock scrolling on <body>; a locked body screenshots as one screen.
  try {
    document.documentElement.style.setProperty('overflow', 'auto', 'important');
    document.body.style.setProperty('overflow', 'auto', 'important');
    document.body.style.setProperty('position', 'static', 'important');
  } catch (e) {}
  return hidden;
})()`;

const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '.cc-allow', '.cc-accept-all',
  '[id*="accept" i]', '[class*="accept-all" i]',
];

/** Consent buttons as users see them: by their label. Greek first — Patras. */
const CONSENT_LABELS = [
  /ΑΠΟΔΟΧΗ/i, /Αποδοχή/i, /Συμφωνώ/i, /Αποδέχομαι/i,
  /^Accept/i, /Accept all/i, /I agree/i, /Got it/i, /OK/i,
];

/**
 * Dismiss a cookie/consent banner so the screenshot shows the site, not the
 * banner. Never throws: the audit's job is the verdict, not a clean picture.
 */
async function dismissConsent(page: Page): Promise<void> {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 1_500, force: true });
        await page.waitForTimeout(400);
        return;
      }
    } catch { /* selector absent, detached, or inside a cross-origin CMP frame */ }
  }
  for (const label of CONSENT_LABELS) {
    try {
      const el = page.getByRole('button', { name: label }).first();
      if (await el.isVisible({ timeout: 400 })) {
        await el.click({ timeout: 1_500, force: true });
        await page.waitForTimeout(400);
        return;
      }
    } catch { /* ditto */ }
  }
}

/** Hide whatever consent furniture survived the click. Also never throws. */
async function hideOverlays(page: Page): Promise<void> {
  try { await page.evaluate(HIDE_OVERLAYS_JS); } catch { /* best effort */ }
}

/**
 * Wait for the page to stop being empty, and report how long that took.
 *
 * Returns the settle duration in ms so the verdict can say "slow render (Ns)"
 * — a site that needs 9 seconds to paint its first sentence is a real finding
 * about that business, just not the same finding as "broken".
 */
async function settleContent(page: Page): Promise<{ ms: number; textLength: number }> {
  const started = Date.now();
  try {
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS });
  } catch { /* a site with a chat widget or analytics beacon never goes idle */ }
  try {
    await page.evaluate(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  } catch { /* no font loading API, or fonts that never resolve */ }

  let textLength = 0;
  for (;;) {
    try { textLength = await page.evaluate(TEXT_LENGTH_JS) as number; } catch { textLength = 0; }
    if (textLength >= SETTLE_MIN_TEXT) break;
    if (Date.now() - started >= SETTLE_MAX_MS) break;
    await page.waitForTimeout(SETTLE_STEP_MS);
  }
  return { ms: Date.now() - started, textLength };
}

/**
 * Console noise that means the PAGE ITSELF failed, as opposed to the ambient
 * third-party noise every real site produces (blocked trackers, CORS on a
 * font, a 404 favicon). Only the former may contribute to `broken`.
 */
const HARD_CONSOLE_ERROR = /uncaught|is not defined|is not a function|cannot read (properties|property)|syntaxerror|failed to load module|chunkloaderror/i;

export interface VerdictInput {
  /** Did any endpoint in the matrix render at all? */
  reachable: boolean;
  /** Is there a working https endpoint? */
  httpsWorks: boolean;
  /** Rendered text length AFTER the settle loop. */
  textLength: number;
  /** Images the page actually put in the DOM. */
  imageCount: number;
  /** Console errors that look like the page's own JS breaking. */
  hardConsoleErrors: number;
  /** Signals that the site is dated (no viewport meta, layout tables, …). */
  datedSignals: string[];
}

/**
 * The verdict rule, as a pure function so it can be tested without a browser.
 *
 * The load-bearing change (Roman, 2026-08-20): **low text alone can never mean
 * `broken`.** A 200 response that paints something is a working site, however
 * thin — to a customer, "their site is a one-page brochure" and "their site is
 * down" are not the same fact, and only the second one justifies building them
 * a demo under the `no_site_only` policy. `broken` now requires either no
 * reachable endpoint at all, or a page that is empty by every measure at once:
 * almost no text AND no images AND its own JS throwing.
 */
export function decideVerdict(input: VerdictInput): { verdict: Verdict; note: string | null } {
  if (!input.reachable) {
    return { verdict: 'broken', note: 'no endpoint rendered' };
  }
  const empty = input.textLength < 100 && input.imageCount === 0 && input.hardConsoleErrors > 0;
  if (empty) {
    return {
      verdict: 'broken',
      note: `page rendered empty after settle (${input.textLength} chars, 0 images, ${input.hardConsoleErrors} js errors)`,
    };
  }
  if (!input.httpsWorks) {
    return { verdict: 'working_with_https_issue', note: 'no working https endpoint' };
  }
  // Thin content is a dated/weak site, not a dead one — it belongs in the same
  // bucket as "no viewport meta", where Roman decides rather than the router.
  const dated = [...input.datedSignals];
  if (input.textLength < SETTLE_MIN_TEXT) dated.push(`thin content (${input.textLength} chars)`);
  if (dated.length) return { verdict: 'outdated', note: `dated: ${dated.join(', ')}` };
  return { verdict: 'working_good', note: null };
}

/**
 * Record a Maps "website" field that points at a social profile as a contact,
 * if it is not already one.
 *
 * Since Roman's 2026-08-19 decision the audit verdict no longer distinguishes
 * `social_only`; the profile survives as `business_contacts` + a UI contact
 * icon. A contact is only written when a `business_sources` row can carry its
 * `source_id` — a fact without a source is a SPEC §5 violation, so no source
 * means the profile is left to enrichment rather than invented here.
 */
async function recordProfileContact(biz: typeof schema.businesses.$inferSelect): Promise<void> {
  const url = biz.websiteUrl;
  if (!url) return;
  const channel = classifySocialUrl(url);
  if (!channel) return;
  const value = cleanProfileUrl(url);

  const existing = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.businessId, biz.id));
  if (existing.some((c) => c.channel === channel && cleanProfileUrl(c.value) === value)) return;

  const sources = await db.select().from(schema.businessSources)
    .where(eq(schema.businessSources.businessId, biz.id));
  const source = sources.find((s) => s.method === 'gosom_api') ?? sources[0];
  if (!source) {
    log.warn('social profile has no source row; contact not recorded', { businessId: biz.id, url });
    return;
  }

  await db.insert(schema.businessContacts).values({
    businessId: biz.id, channel, value, sourceId: source.id, verified: true,
  });
  log.info('social profile recorded as contact', { businessId: biz.id, channel, value });
}

export async function auditHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);

  let verdict: Verdict = 'no_website';
  let matrix: EndpointResult[] = [];
  let bestEndpoint: string | null = null;
  let desktopKey: string | null = null;
  let desktopFullKey: string | null = null;
  let mobileKey: string | null = null;
  let meaningful: boolean | null = null;
  const notes: string[] = [];

  // Social/booking-only presence: `domain` is null but the listing pointed
  // somewhere. That is an opportunity, not an owned website.
  const socialOnly = !biz.domain && !!biz.websiteUrl && classifySocialUrl(biz.websiteUrl) !== null;
  const directoryOnly = !biz.domain && !!biz.websiteUrl && classifySocialUrl(biz.websiteUrl) === null;

  if (!biz.domain) {
    verdict = 'no_website';
    if (directoryOnly) notes.push(`directory/booking profile only: ${biz.websiteUrl}`);
    else if (socialOnly) notes.push(`social profile only: ${biz.websiteUrl}`);
    // The profile is a CONTACT, not a verdict of its own. Enrichment normally
    // writes it from the gosom listing; this is the backstop for businesses
    // whose listing was read before that path existed, so the merge of
    // `social_only` into `no_website` never loses the profile.
    if (socialOnly) await recordProfileContact(biz);
  } else {
    const bare = biz.domain;
    matrix = await Promise.all([
      `https://${bare}`, `https://www.${bare}`, `http://${bare}`, `http://www.${bare}`,
    ].map(probe));

    const reachable = matrix.filter((m) => m.status !== null && m.status < 400);
    const httpsWorks = reachable.some((m) => m.url.startsWith('https'));
    // prefer a working https endpoint; otherwise anything that renders
    bestEndpoint = reachable.find((m) => m.url.startsWith('https'))?.finalUrl ?? reachable[0]?.finalUrl ?? null;

    if (!bestEndpoint) {
      verdict = 'broken';
      const errs = matrix.map((m) => `${m.url}: ${m.error ?? m.status}`).join(' | ');
      notes.push(`all endpoints failed -> ${errs}`.slice(0, 600));
    } else {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      try {
        const dCtx = await browser.newContext({
          viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true,
          // Retina. The old 1x captures were the "криві скріншоти" Roman
          // complained about: half-loaded and blurry at the size the UI shows them.
          deviceScaleFactor: 2,
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        });
        const dPage: Page = await dCtx.newPage();
        const consoleErrors: string[] = [];
        dPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 150)); });

        await dPage.goto(bestEndpoint, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const settle = await settleContent(dPage);
        // Only AFTER the page has settled: a banner clicked at t=0 is a banner
        // that has not been injected yet, and signals read at t=0 are a lie.
        await dismissConsent(dPage);
        await hideOverlays(dPage);
        const signals = await dPage.evaluate(MODERN_JS) as ModernSignals;
        meaningful = signals.textLength > SETTLE_MIN_TEXT;
        desktopKey = await putRaw(`audits/${businessId}/desktop`, await dPage.screenshot({ fullPage: false }), 'image/png');
        // Extra evidence: the whole page, so a verdict can be checked by eye
        // instead of by the top 900px. Lazy-loaded imagery below the fold needs
        // a scroll pass first, otherwise the full capture is bands of blank.
        try {
          await dPage.evaluate(`(async () => {
            const step = window.innerHeight;
            for (let y = 0; y < document.body.scrollHeight; y += step) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 150));
            }
            window.scrollTo(0, 0);
          })()`);
          await dPage.waitForTimeout(500);
          await hideOverlays(dPage);
          desktopFullKey = await putRaw(
            `audits/${businessId}/desktop-full`,
            await dPage.screenshot({ fullPage: true }),
            'image/png',
          );
        } catch (err) {
          // A page too tall for one buffer must not cost us the verdict.
          log.warn('full-page screenshot failed', { businessId, err: String(err).slice(0, 200) });
        }

        const mCtx = await browser.newContext({
          viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
          deviceScaleFactor: 2,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        });
        const mPage = await mCtx.newPage();
        await mPage.goto(bestEndpoint, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settleContent(mPage);
        await dismissConsent(mPage);
        // horizontal overflow on a phone is the classic "not responsive" tell —
        // measured BEFORE hiding overlays, so a hidden banner cannot mask it
        const overflows = await mPage.evaluate(
          `(document.documentElement.scrollWidth - document.documentElement.clientWidth) > 20`,
        ) as boolean;
        await hideOverlays(mPage);
        mobileKey = await putRaw(`audits/${businessId}/mobile`, await mPage.screenshot({ fullPage: false }), 'image/png');

        // ── verdict ──
        const hardConsoleErrors = consoleErrors.filter((e) => HARD_CONSOLE_ERROR.test(e)).length;
        const decision = decideVerdict({
          reachable: true,
          httpsWorks,
          textLength: signals.textLength,
          imageCount: signals.imageCount,
          hardConsoleErrors,
          datedSignals: [
            !signals.hasViewport && 'no viewport meta',
            !signals.hasResponsiveCss && 'no media queries',
            overflows && 'mobile horizontal overflow',
            signals.hasFlash && 'flash object',
            signals.datedGenerator && `dated generator (${signals.generator})`,
            signals.layoutTables > 3 && `${signals.layoutTables} layout tables`,
          ].filter(Boolean) as string[],
        });
        verdict = decision.verdict;
        if (decision.note) notes.push(decision.note);
        // A site that takes 9s to paint its first sentence is a real finding
        // about that business — just not the same finding as "broken".
        if (settle.ms > SLOW_RENDER_MS) {
          notes.push(`slow render (${(settle.ms / 1000).toFixed(1)}s to settle)`);
        }
        if (consoleErrors.length) {
          notes.push(`console_errors=${consoleErrors.length}${hardConsoleErrors ? ` (hard=${hardConsoleErrors})` : ''}`);
        }
        if (signals.generator) notes.push(`generator=${signals.generator.slice(0, 60)}`);
      } catch (err) {
        verdict = 'broken';
        notes.push(`render failed: ${String(err).slice(0, 200)}`);
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  // ── contradiction check against enrichment (spec §4 stage 6) ─────────────
  const facts = await db.select().from(schema.businessFacts)
    .where(eq(schema.businessFacts.businessId, businessId));
  const sources = await db.select().from(schema.businessSources)
    .where(eq(schema.businessSources.businessId, businessId));
  const capturedOwnedSite = sources.some((s) => s.sourceType === 'owned_website');
  const servicesFromSite = facts.filter((f) => f.key === 'service').length;

  const contradictions: string[] = [];
  // enrichment read an owned site, but the audit says there is none
  if (capturedOwnedSite && verdict === 'no_website') {
    contradictions.push(`enrichment captured an owned website but audit verdict=${verdict}`);
  }
  // the audit rendered a real site, but enrichment found no owned domain at all
  if ((verdict === 'outdated' || verdict === 'working_good' || verdict === 'working_with_https_issue')
    && !biz.domain) {
    contradictions.push(`audit rendered ${verdict} without an owned domain on the business`);
  }
  // a domain resolves and renders content, yet enrichment extracted nothing from it
  if (capturedOwnedSite && servicesFromSite === 0 && verdict === 'working_good') {
    contradictions.push('owned website renders well but enrichment extracted zero services from it');
  }
  if (contradictions.length) notes.push(`CONTRADICTION: ${contradictions.join('; ')}`);

  await db.insert(schema.websiteAudits).values({
    businessId, endpointMatrix: matrix, bestEndpoint, verdict,
    desktopScreenshotKey: desktopKey, desktopFullScreenshotKey: desktopFullKey,
    mobileScreenshotKey: mobileKey,
    meaningfulContent: meaningful, notes: notes.join(' | ').slice(0, 2000) || null,
  });
  log.info('audit done', { businessId, verdict, bestEndpoint, contradictions: contradictions.length });

  if (contradictions.length) {
    const transitioned = await businessTransitions.normal({
      businessId,
      expectedStatus,
      to: 'needs_review',
      actor: 'audit-worker',
      reason: `contradiction: ${contradictions.join('; ')}`.slice(0, 300),
    });
    canContinueAfterTransition(transitioned, { businessId, actor: 'audit-worker' });
    return;
  }
  const stillCurrent = await businessTransitions.normal({
    businessId,
    expectedStatus,
    to: expectedStatus,
    actor: 'audit-worker',
  });
  if (!canContinueAfterTransition(stillCurrent, { businessId, actor: 'audit-worker' })) return;
  await enqueue('score-and-qa', { businessId, campaignId: biz.campaignId });
}
