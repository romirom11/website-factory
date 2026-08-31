/**
 * Stage 5 — asset collection (spec §4).
 *
 * Downloads the images enrichment offered (Google listing photos, the site's
 * og:image/logo/hero, social imagery) and stores each with a content hash,
 * provenance and `rights='private_demo_only'` (spec §8).
 *
 * Everything here is a REAL photo of/from the business — nothing is generated.
 * `ai_generated` stays false; media generation is a separate, clearly-marked
 * path (spec §2.5).
 */
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getObject, putAsset, sha256 } from '../lib/storage.js';
import { log } from '../lib/logger.js';
import { config } from '../config.js';
import { createHash } from 'node:crypto';
import { safeFetchImage } from '../lib/safeFetch.js';

/**
 * Decode a `data:image/...;base64,...` URI into the same shape safeFetchImage
 * returns. Sites that inline their real photos (base64 in the HTML) are
 * otherwise invisible to the asset collector — the bytes are local, no SSRF
 * surface, but the type allowlist and the 10MB cap still apply.
 */
function decodeDataUri(uri: string): { buffer: Buffer; contentType: string } | { blocked: string } {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(uri);
  if (!m) return { blocked: 'data URI is not a base64 image' };
  const contentType = m[1].toLowerCase();
  if (contentType.includes('svg')) return { blocked: 'inline svg data URI (script-capable), skipped' };
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > 10 * 1024 * 1024) return { blocked: 'inline image over 10MB cap' };
  return { buffer, contentType };
}
import { logoCandidatesFromHtml, rankLogoCandidates, type LogoCandidate } from './logoHunt.js';
import { photoCandidatesFromHtml } from './photoHunt.js';

export interface AssetImageRef {
  url: string;
  kind: 'hero' | 'logo' | 'gallery' | 'menu';
  sourceRef?: string;
  /** Which capture this URL was found in — recorded on the asset. */
  origin?: string;
  /** Why the logo hunter picked it, kept for the audit trail. */
  reasons?: string[];
}

export interface AssetCollectionInput {
  businessId: string;
  imageUrls?: readonly unknown[];
}

export interface AssetCollectionResult {
  offered: number;
  saved: number;
  logosSaved: number;
  duplicate: number;
  skippedSmall: number;
  failed: number;
  blocked: number;
  minedLogos: number;
  minedPhotos: number;
  hasLogo: boolean;
}

// Read at call time, not at import time: config values are now resolved
// lazily from the UI settings store, and a module-level capture would
// freeze whatever was current when this module first loaded.
const MIN_BYTES = 6_000;      // below this it is an icon or a tracking pixel
const MIN_EDGE = 400;         // usable in a hero/gallery
const MIN_LOGO_EDGE = 120;    // logos are legitimately small

/**
 * Image dimensions from the file header. Covers the formats that actually turn
 * up here: PNG, JPEG, WebP (VP8/VP8L/VP8X) and GIF. Unknown format => nulls,
 * and the caller keeps the asset rather than discarding evidence.
 */
export function dimsFromBuffer(buf: Buffer): { width: number | null; height: number | null } {
  // PNG: IHDR is always the first chunk
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF87a / GIF89a: little-endian logical screen size
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') {
      // lossy: 14-bit dimensions after the 3-byte start code
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fmt === 'VP8L') {
      // lossless: 14 bits each, packed across 4 bytes after the signature byte
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') {
      // extended: 24-bit canvas size minus one
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: w + 1, height: h + 1 };
    }
  }
  // JPEG: walk the marker chain to the SOFn frame header
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len <= 0) break;
      i += 2 + len;
    }
  }
  return { width: null, height: null };
}

/**
 * Google user-content URLs carry their render size in the path
 * (`=w408-h272-k-no`). Asking for a bigger render gives us a usable hero
 * instead of a thumbnail — same photo, same source, just not pre-shrunk.
 */
export function upsizeGoogleImage(url: string): string {
  if (!/googleusercontent\.com|ggpht\.com/.test(url)) return url;
  return url.replace(/=(?:[swh]\d+|[a-z]+)(?:-[a-z0-9]+)*$/i, '=s1600');
}

function extFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('svg')) return 'svg';
  return 'jpg';
}

/**
 * Logos and photographs mined out of the captures ALREADY in object storage.
 *
 * WHY THIS RUNS HERE and not only during enrichment. The offers on the job
 * payload come from one live Playwright page and from the gosom listing, and
 * they were produced by a regex that tagged anything matching `/logo|brand/` as
 * a logo — which is how The Parlor ended up with L'Oréal, Wella and Farcom in
 * its `logo` assets and Elegant Hairdesign with a booking widget's mark
 * (`src/enrichment/logoHunt.ts` documents the full autopsy).
 *
 * Reading the STORED HTML instead has three properties the live path does not:
 * it can be re-run for a business whose browser session ended weeks ago, it
 * sees every captured page rather than only the one enrichment landed on, and
 * it costs no requests to the business's site — the evidence is already ours.
 *
 * Everything returned was literally present in a captured page. The capture's
 * `source_id` travels with it, so an asset is always traceable to a page a
 * person can open.
 */
async function mineCaptures(
  businessId: string,
  siteHost: string | null,
): Promise<{ logos: AssetImageRef[]; photos: AssetImageRef[]; notes: string[] }> {
  const notes: string[] = [];
  const sources = await db.select().from(schema.businessSources)
    .where(eq(schema.businessSources.businessId, businessId));

  // Newest capture per (type, url): an older version is superseded evidence.
  const latest = new Map<string, typeof sources[number]>();
  for (const s of sources) {
    if (!s.rawObjectKey) continue;
    const key = `${s.sourceType}|${s.url}`;
    const prev = latest.get(key);
    if (!prev || s.capturedAt.getTime() > prev.capturedAt.getTime()) latest.set(key, s);
  }

  const logoPool: Array<LogoCandidate & { origin: string }> = [];
  const photos: AssetImageRef[] = [];

  for (const src of latest.values()) {
    const type = src.sourceType;
    if (type !== 'owned_website' && type !== 'instagram' && type !== 'facebook') continue;

    let html: string;
    try {
      html = (await getObject('raw', src.rawObjectKey!)).toString('utf8');
    } catch (err) {
      notes.push(`capture ${src.rawObjectKey} unreadable: ${String(err).slice(0, 80)}`);
      continue;
    }

    if (type === 'owned_website') {
      for (const c of logoCandidatesFromHtml(html, src.url)) {
        logoPool.push({ ...c, origin: 'site' });
      }
      for (const p of photoCandidatesFromHtml(html, src.url, { origin: 'site' })) {
        photos.push({ url: p.url, kind: p.kind, sourceRef: String(src.id), origin: 'site' });
      }
    } else {
      // A social profile's `og:image` IS the avatar — for a business with no
      // website that is the closest thing to a logo it publishes. It is offered
      // as a logo CANDIDATE and still has to out-score everything else; it is
      // not promoted to "the logo" just for existing.
      //
      // Post thumbnails are deliberately NOT faked up: Instagram serves them to
      // a logged-in session only, and the captured HTML for these businesses
      // carries the avatar and follower counts. What is public is taken; the
      // login wall stays a gap.
      for (const p of photoCandidatesFromHtml(html, src.url, { origin: type })) {
        if (p.via === 'og:image') {
          logoPool.push({
            url: p.url, via: `${type} profile picture (og:image)`, position: 'declared',
            width: null, height: null, alt: '', attrs: `${type} avatar`, svg: false,
            origin: type,
          });
        }
        photos.push({ url: p.url, kind: p.kind, sourceRef: String(src.id), origin: type });
      }
    }
  }

  // The social avatar competes without a same-origin comparison: an Instagram
  // CDN host is never the business's domain, and penalising it as "off-site"
  // would reject the only mark a social-only business has.
  const ranked = rankLogoCandidates(logoPool, {
    siteHost,
    limit: 2,
    minScore: 20,
  });
  const originOf = new Map(logoPool.map((c) => [c.url, c.origin]));
  const logos: AssetImageRef[] = ranked.map((c) => ({
    url: c.url,
    kind: 'logo' as const,
    origin: originOf.get(c.url) ?? 'site',
    reasons: c.reasons,
  }));

  if (logoPool.length && logos.length === 0) {
    notes.push(`${logoPool.length} logo candidates examined, none convincing enough to keep`);
  }
  return { logos, photos, notes };
}

export async function collectAssets(input: AssetCollectionInput): Promise<AssetCollectionResult> {
  const businessId = input.businessId;
  const offered = (input.imageUrls ?? []) as unknown as AssetImageRef[];

  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const siteHost = (() => {
    const raw = biz?.domain ?? biz?.websiteUrl;
    if (!raw) return null;
    try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname; } catch { return null; }
  })();

  // Mine the stored captures BEFORE the payload offers, so a scored logo is
  // what enters the queue rather than whatever the enrichment regex guessed.
  const mined = await mineCaptures(businessId, siteHost);
  if (mined.notes.length) log.warn('capture mining notes', { businessId, notes: mined.notes.slice(0, 6) });

  // Anything the offer list called a logo is DEMOTED to a gallery candidate.
  // That tag came from `/logo|brand/` over src+alt+class, which is precisely
  // the rule that admitted eight partner brands; the scored hunt above is now
  // the only thing allowed to call an image a logo. The images themselves are
  // still collected — a mis-tagged file is usually a real photo — they simply
  // stop claiming to be this business's mark.
  const demoted = offered.map((img) => (
    img?.kind === 'logo' ? { ...img, kind: 'gallery' as const } : img
  ));

  // Dedupe by URL before spending any network calls. Logos go FIRST: the
  // download budget is finite and a business's own mark is worth more than its
  // twentieth interior shot.
  const seenUrls = new Set<string>();
  const queue: AssetImageRef[] = [];
  for (const img of [...mined.logos, ...demoted, ...mined.photos]) {
    if (!img?.url) continue;
    const isInline = img.url.startsWith('data:image/');
    if (!isInline && !/^https?:\/\//i.test(img.url)) continue;
    const url = isInline ? img.url : upsizeGoogleImage(img.url);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    queue.push({ ...img, url });
  }

  // Hashes and URLs already stored for this business, so a re-run is idempotent
  // and a backfill does not re-download what it already holds.
  const existing = await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));
  const seenHashes = new Set(existing.map((a) => a.hash));
  const storedUrls = new Set(existing.map((a) => a.sourceUrl));

  let saved = 0, skippedSmall = 0, failed = 0, duplicate = 0, blocked = 0, logosSaved = 0;

  for (const img of queue.slice(0, config.pipeline.maxAssetDownloads)) {
    // Already downloaded from this exact URL on a previous run. Re-fetching
    // would only prove the hash unchanged, at the cost of a request.
    if (storedUrls.has(img.url) && img.kind !== 'logo') { duplicate++; continue; }
    try {
      // These URLs come from SCRAPED PAGES — a gosom listing's photo links and
      // `<img src>` harvested off the business's own site. Fetching them from a
      // worker inside the compose network, next to minio/postgres/gosom, is a
      // server-side request forgery primitive, so they go through the same
      // guard as the brand avatars: http/https only, DNS checked against the
      // private/loopback/link-local ranges, redirects revalidated per hop, and
      // the body capped by size and content-type.
      // Inline base64 images need no network at all: the bytes are already in
      // the captured HTML. Decode locally — same size/dimension gates apply.
      const fetched = img.url.startsWith('data:')
        ? decodeDataUri(img.url)
        : await safeFetchImage(img.url, {
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: 20_000,
          });
      if ('blocked' in fetched) {
        // A refusal is logged distinctly from a network failure: "we would not
        // fetch this" and "we could not fetch this" are different facts, and
        // conflating them would hide a scraped page pointing at internal hosts.
        blocked++;
        log.warn('asset download refused', {
          businessId, url: img.url.slice(0, 160), reason: fetched.blocked,
        });
        continue;
      }
      const contentType = fetched.contentType || 'image/jpeg';
      const buf = fetched.buffer;
      const isLogo = img.kind === 'logo';
      const isSvg = contentType.includes('svg');

      // A vector wordmark is routinely 2-4 KB and is the BEST asset a business
      // can give us — it scales into a hero at any size. The 6 KB floor exists
      // to drop tracking pixels and UI icons from the photo stream; applying it
      // to an SVG logo would throw away the one file that cannot pixelate.
      const minBytes = isSvg ? 400 : MIN_BYTES;
      if (buf.length < minBytes) { skippedSmall++; continue; }

      // SVG has no raster header to read; `dimsFromBuffer` correctly returns
      // nulls and the dimension gate below skips it, which is the right
      // behaviour — a vector has no intrinsic pixel size to judge.
      const { width, height } = dimsFromBuffer(buf);
      const minEdge = isLogo ? MIN_LOGO_EDGE : MIN_EDGE;
      // Unknown dimensions (null) are kept: the file is real evidence and the
      // byte-size floor already removed icons.
      if (width !== null && height !== null && (width < minEdge || height < minEdge)) {
        skippedSmall++;
        continue;
      }

      const hash = sha256(buf);
      if (seenHashes.has(hash)) { duplicate++; continue; }
      seenHashes.add(hash);

      const objectKey = `${businessId}/${img.kind}-${hash.slice(0, 12)}.${extFor(contentType)}`;
      await putAsset(objectKey, buf, contentType);
      const inserted = await db.insert(schema.assets).values({
        businessId, objectKey, hash,
        // A data URI is megabytes of base64 — persist a short content-hash
        // pointer instead; the bytes themselves are the stored asset.
        sourceUrl: img.url.startsWith('data:')
          ? `inline-data-uri:sha256-${createHash('sha256').update(img.url).digest('hex').slice(0, 16)}`
          : img.url,
        // `origin` is where the file was FOUND, which is what the source type
        // has always meant here. The mined assets know it exactly; the payload
        // offers still fall back to the old gosom/website split.
        sourceType: img.origin === 'instagram' || img.origin === 'facebook'
          ? img.origin
          : img.sourceRef === 'gosom' ? 'google_maps' : 'owned_website',
        contentType, width, height,
        intendedUsage: img.kind,
        rights: 'private_demo_only',
        aiGenerated: false, // real photography only; generated media is marked elsewhere
        // Not a generation record — `assets` has no free-form column and this
        // is the audit trail for WHY an image was called this business's logo.
        // `aiGenerated` stays false, so nothing downstream reads it as media we
        // produced; `generator` stays null for the same reason.
        generationMeta: isLogo || img.origin
          ? {
            origin: img.origin ?? null,
            svg: isSvg || null,
            logoScoreReasons: img.reasons ?? null,
          }
          : null,
      }).onConflictDoNothing().returning({ id: schema.assets.id });
      if (inserted.length) {
        saved++;
        if (isLogo) logosSaved++;
      } else {
        duplicate++;
      }
    } catch (err) {
      failed++;
      log.warn('asset download failed', { businessId, url: img.url.slice(0, 120), err: String(err).slice(0, 150) });
    }
  }

  log.info('assets collected', {
    businessId, offered: queue.length, saved, logosSaved, duplicate, skippedSmall, failed, blocked,
    minedLogos: mined.logos.length, minedPhotos: mined.photos.length,
  });

  // ── "This business publishes no mark we could find" is a FACT ────────────
  //
  // Soft, not hard. The `hero_or_logo` readiness gate is unchanged and still
  // passes on a large photo — a salon with beautiful interior shots and no
  // logo file is a perfectly buildable demo, and hardening this would strand
  // most of the Patras set for a cosmetic reason. What the gap does is tell the
  // art director to BUILD a typographic identity rather than hunt for a mark
  // that does not exist, and tell a person why the header has no logo in it.
  const haveLogo = await db.select().from(schema.assets).where(and(
    eq(schema.assets.businessId, businessId),
    eq(schema.assets.intendedUsage, 'logo'),
  ));
  const openLogoGap = await db.select().from(schema.productionGaps).where(and(
    eq(schema.productionGaps.businessId, businessId),
    eq(schema.productionGaps.gap, 'logo_missing'),
    eq(schema.productionGaps.resolved, false),
  ));
  if (haveLogo.length === 0 && openLogoGap.length === 0) {
    await db.insert(schema.productionGaps).values({
      businessId, gap: 'logo_missing', blockerLevel: 'soft',
    });
  } else if (haveLogo.length > 0 && openLogoGap.length > 0) {
    await db.update(schema.productionGaps).set({ resolved: true }).where(and(
      eq(schema.productionGaps.businessId, businessId),
      eq(schema.productionGaps.gap, 'logo_missing'),
      eq(schema.productionGaps.resolved, false),
    ));
  }

  return {
    offered: queue.length,
    saved,
    logosSaved,
    duplicate,
    skippedSmall,
    failed,
    blocked,
    minedLogos: mined.logos.length,
    minedPhotos: mined.photos.length,
    hasLogo: haveLogo.length > 0,
  };
}
