/**
 * Media wiring for the build stage (SPEC §2.5, decisions #12/#13).
 *
 * Two optional enhancements, both non-fatal by design — a demo without a hero clip
 * is a slightly less impressive demo, but a demo that fails to build because a
 * media backend was down is a broken pipeline:
 *
 *   1. hero motion: an UPLOADED wow-clip (hero_clip asset, added from the business
 *      card) → ffmpeg Ken Burns mp4 from the real photo → a CSS/GSAP Ken Burns
 *      config the builder applies to the real still.
 *   2. one decorative background image via gen-image (Codex), off by MEDIA_GEN_IMAGES=false.
 *
 * Everything generated here is registered through `registerGeneratedAsset`, which
 * hard-codes `ai_generated=true` + `rights='private_demo_only'`.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  fallbackHeroMedia,
  generateHeroClip,
  generateImage,
  registerGeneratedAsset,
} from '../media/index.js';
import { getObject } from '../lib/storage.js';
import { writeFile } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import type { HeroMediaPlan } from './workspace.js';
import { realPhotos, type BuildSnapshot } from './snapshot.js';

/**
 * Most recent AI-generated asset of this kind for this business, or null.
 * The durable record of "we already paid for this generation" lives in the DB.
 */
async function findGeneratedAsset(businessId: string, kind: string) {
  const rows = await db.select().from(schema.assets).where(and(
    eq(schema.assets.businessId, businessId),
    eq(schema.assets.intendedUsage, kind),
    eq(schema.assets.aiGenerated, true),
  )).orderBy(desc(schema.assets.capturedAt), desc(schema.assets.id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Make a reused asset visible to the builder: the workspace copies files from
 * `snapshot.assets`, so an asset missing from it would never reach public/.
 */
function addToSnapshot(
  snapshot: BuildSnapshot,
  row: { objectKey: string; contentType: string | null; generator: string | null; width: number | null; height: number | null },
  file: string,
  kind: string,
): void {
  if (snapshot.assets.some((a) => a.objectKey === row.objectKey)) return;
  snapshot.assets.push({
    file, objectKey: row.objectKey, kind,
    width: row.width, height: row.height,
    contentType: row.contentType,
    aiGenerated: true, generator: row.generator,
    sourceUrl: `generated://${row.generator ?? 'unknown'}`,
  });
}

/** Scratch space for media generation, outside the workspace the agent edits. */
function mediaDir(businessId: string, projectId: number): string {
  return path.resolve('sites', businessId, `.media-${projectId}`);
}

/**
 * Produce the hero motion plan. Never throws: any failure degrades to the next
 * rung of the chain, and the last rung (a still hero) needs nothing external.
 */
export async function planHeroMedia(
  snapshot: BuildSnapshot,
  projectId: number,
  opts: { category?: string | null } = {},
): Promise<HeroMediaPlan> {
  const photos = realPhotos(snapshot);
  const hero = photos.find((p) => p.kind === 'hero') ?? photos[0];

  if (!hero) {
    return {
      kind: 'none', file: null, sourceFile: null, aiGenerated: false,
      respectReducedMotion: true,
      note: 'No real photograph in the evidence package — build a typographic hero instead of inventing imagery.',
    };
  }

  // Idempotency + the upload path: the LATEST hero_clip asset wins here, which
  // is also how an uploaded wow-clip replaces the generated Ken Burns one. The check has to hit the DB, NOT the snapshot: the snapshot is frozen at
  // stage 9, before any media exists, so it can never show a previous generation.
  // `registerGeneratedAsset` dedupes by content hash, but a fresh generation
  // produces fresh bytes, so the reuse decision must happen before generating.
  const existingClip = await findGeneratedAsset(snapshot.businessId, 'hero_clip');
  if (existingClip) {
    const file = `generated/${path.basename(existingClip.objectKey)}`;
    log.info('reusing existing hero clip', {
      businessId: snapshot.businessId, objectKey: existingClip.objectKey,
    });
    addToSnapshot(snapshot, existingClip, file, 'hero_clip');
    return {
      kind: 'clip', file, sourceFile: hero.file, aiGenerated: true,
      durationSec: (existingClip.generationMeta as { durationSec?: number } | null)?.durationSec,
      respectReducedMotion: true,
      note: 'AI-derived motion over a real evidence photo. Poster must be the real still.',
    };
  }

  const dir = mediaDir(snapshot.businessId, projectId);
  await mkdir(dir, { recursive: true });

  // The generator needs the bytes on disk; pull the real photo out of storage.
  const localPhoto = path.join(dir, path.basename(hero.file));
  try {
    await writeFile(localPhoto, await getObject('assets', hero.objectKey));
  } catch (err) {
    log.warn('hero photo unavailable for media generation', {
      businessId: snapshot.businessId, objectKey: hero.objectKey, err: String(err).slice(0, 200),
    });
    return {
      kind: 'none', file: null, sourceFile: hero.file, aiGenerated: false,
      respectReducedMotion: true,
      note: 'Hero photo could not be read from storage; build a still hero.',
    };
  }

  const niche = opts.category ?? snapshot.category ?? 'local business';
  const prompt =
    `Subtle cinematic ambience derived from this real photograph of a ${niche}. ` +
    `Very slow camera drift and gentle light movement only. Do not add, remove or alter ` +
    `any object, person, sign or text in the frame. Photographic, natural colour, no effects.`;

  try {
    const clip = await generateHeroClip({
      imagePath: localPhoto,
      prompt,
      outDir: dir,
    });
    if (clip) {
      const registered = await registerGeneratedAsset(snapshot.businessId, clip.filePath, 'hero_clip', {
        generator: 'ken-burns',
        prompt: clip.prompt,
        sourceImagePath: hero.objectKey,
        durationSec: clip.durationSec,
      });
      const file = `generated/${path.basename(registered.objectKey)}`;
      // Keep the snapshot honest: the clip is now part of the evidence package.
      if (!snapshot.assets.some((a) => a.objectKey === registered.objectKey)) {
        snapshot.assets.push({
          file, objectKey: registered.objectKey, kind: 'hero_clip',
          width: null, height: null, contentType: 'video/mp4',
          aiGenerated: true, generator: 'ken-burns',
          sourceUrl: 'generated://ken-burns',
        });
      }
      log.info('hero clip generated', {
        businessId: snapshot.businessId, source: clip.source, durationSec: clip.durationSec,
      });
      return {
        kind: 'clip', file, sourceFile: hero.file, aiGenerated: true,
        durationSec: clip.durationSec, respectReducedMotion: true,
        note: 'AI-derived motion over a real evidence photo. Poster must be the real still.',
      };
    }
  } catch (err) {
    log.warn('hero clip generation failed, degrading to browser Ken Burns', {
      businessId: snapshot.businessId, err: String(err).slice(0, 300),
    });
  }

  const fallback = fallbackHeroMedia({ imagePath: localPhoto, reason: 'ffmpeg unavailable' });
  return {
    kind: 'ken-burns',
    file: null,
    sourceFile: hero.file,
    aiGenerated: false,
    durationSec: (fallback as { durationSec?: number }).durationSec ?? 20,
    kenBurns: fallback as unknown as Record<string, unknown>,
    respectReducedMotion: true,
    note: 'No video file: animate the real still in the browser. Nothing here is AI-generated.',
  };
}

/**
 * One optional decorative background. Returns the workspace-relative file or null.
 * Controlled by `MEDIA_GEN_IMAGES` (default on); failure is logged and ignored.
 */
export async function generateDecorativeBackground(
  snapshot: BuildSnapshot,
  projectId: number,
  design: { palette: { background: string; accent: string; derivedFrom: string }; name: string },
): Promise<string | null> {
  if (!config.media.generateImages) return null;

  // Same idempotency rule as the hero clip, and for the same reason: the frozen
  // snapshot predates every generation, so reuse must be decided against the DB.
  const existing = await findGeneratedAsset(snapshot.businessId, 'background');
  if (existing) {
    const file = `generated/${path.basename(existing.objectKey)}`;
    log.info('reusing existing decorative background', {
      businessId: snapshot.businessId, objectKey: existing.objectKey,
    });
    addToSnapshot(snapshot, existing, file, 'background');
    return file;
  }

  const dir = mediaDir(snapshot.businessId, projectId);
  await mkdir(dir, { recursive: true });

  const prompt =
    `Abstract decorative background texture for a premium ${snapshot.category ?? 'beauty'} website. ` +
    `Palette: background ${design.palette.background}, single accent ${design.palette.accent}. ` +
    `Soft organic gradient or fine material grain — plaster, silk, stone or paper. ` +
    `NO text, NO logos, NO people, NO faces, NO recognisable objects, NO product shots, ` +
    `NO purple-to-blue gradient. Flat, quiet, low contrast; it sits behind type.`;

  try {
    const img = await generateImage({ prompt, outDir: dir, size: 'landscape' });
    const registered = await registerGeneratedAsset(snapshot.businessId, img.filePath, 'background', {
      generator: 'gen-image:gpt-image-2',
      prompt: img.prompt,
    });
    const file = `generated/${path.basename(registered.objectKey)}`;
    if (!snapshot.assets.some((a) => a.objectKey === registered.objectKey)) {
      snapshot.assets.push({
        file, objectKey: registered.objectKey, kind: 'background',
        width: null, height: null, contentType: img.contentType ?? 'image/png',
        aiGenerated: true, generator: 'gen-image:gpt-image-2',
        sourceUrl: 'generated://gen-image:gpt-image-2',
      });
    }
    log.info('decorative background generated', { businessId: snapshot.businessId, file });
    return file;
  } catch (err) {
    // Decoration is not evidence: its absence degrades the build, never blocks it.
    log.warn('decorative image generation skipped', {
      businessId: snapshot.businessId, err: String(err).slice(0, 300),
    });
    return null;
  }
}
