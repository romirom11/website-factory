/**
 * Media adapters smoke check (SPEC §2.5).
 *
 *   pnpm tsx scripts/verify-media.ts            # image (real) + hero clip (ffmpeg)
 *   pnpm tsx scripts/verify-media.ts --no-image # skip the Codex call
 *
 * Touches no database: the adapters are exercised as pure functions, so this
 * runs without Postgres/MinIO. Asset registration is covered by the pipeline.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  generateImage,
  ImageGenerationError,
  generateHeroClip,
  fallbackHeroMedia,
  ffmpegAvailable,
} from '../src/media/index.js';
import { config } from '../src/config.js';

const OUT_DIR = path.resolve('storage/media-verify');
const args = new Set(process.argv.slice(2));
const skipImage = args.has('--no-image');

function heading(title: string): void {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`);
}

/** A tiny real-looking photo stand-in so the video path has an input without evidence data. */
async function makeSampleImage(): Promise<string> {
  const target = path.join(OUT_DIR, 'sample-photo.png');
  if (await stat(target).then((s) => s.isFile()).catch(() => false)) return target;

  if (await ffmpegAvailable()) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.media.ffmpegBin, [
        '-y', '-f', 'lavfi', '-i', 'gradients=s=1280x720:n=3:d=1', '-frames:v', '1', target,
      ], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return target;
  }

  // 1x1 PNG fallback — enough to prove the code path, useless as a real photo.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(target, png);
  return target;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  let failures = 0;

  // ── 1. Image: real generation through the Codex CLI ────────────────────────
  heading('1. gen-image (Codex CLI, gpt-image-2) — REAL generation');
  if (skipImage) {
    console.log('skipped (--no-image)');
  } else {
    const started = Date.now();
    try {
      const img = await generateImage({
        prompt: 'a subtle abstract pastel background texture, soft blush and warm sand tones, '
          + 'gentle organic gradient, no text, no objects',
        size: 'landscape',
        outDir: OUT_DIR,
        fileName: 'verify-background',
      });
      console.log(`  ok         : ${img.filePath}`);
      console.log(`  bytes      : ${img.bytes.toLocaleString()}`);
      console.log(`  contentType: ${img.contentType}`);
      console.log(`  model      : ${img.model} via ${img.provider}`);
      console.log(`  duration   : ${(img.durationMs / 1000).toFixed(1)}s`);
      console.log(`  aiGenerated: ${img.aiGenerated} (registers as private_demo_only)`);
    } catch (err) {
      failures++;
      if (err instanceof ImageGenerationError) {
        console.error(`  FAILED [${err.reason}] after ${((Date.now() - started) / 1000).toFixed(1)}s`);
        console.error(`  ${err.message}`);
      } else {
        console.error(`  FAILED: ${String(err)}`);
      }
    }
  }

  // Hero clip through the local deterministic renderer.
  heading('2. generateHeroClip — ffmpeg Ken Burns');
  const samplePhoto = await makeSampleImage();
  console.log(`  input photo: ${samplePhoto}`);
  console.log(`  ffmpeg     : ${(await ffmpegAvailable()) ? config.media.ffmpegBin : 'NOT AVAILABLE'}`);
  try {
    const clip = await generateHeroClip({
      imagePath: samplePhoto,
      prompt: 'slow cinematic push-in, warm natural light',
      durationSec: 4,
      outDir: OUT_DIR,
      fileName: 'verify-hero-ken-burns',
    });
    if (clip) {
      console.log(`  ok         : ${clip.filePath}`);
      console.log(`  bytes      : ${clip.bytes.toLocaleString()}`);
      console.log(`  source     : ${clip.source}`);
      console.log(`  duration   : ${clip.durationSec}s, took ${(clip.durationMs / 1000).toFixed(1)}s`);
      console.log(`  fromPhoto  : ${clip.sourceImagePath}`);
    } else {
      console.log('  no clip (ffmpeg missing) — pipeline must use fallbackHeroMedia()');
    }
  } catch (err) {
    failures++;
    console.error(`  FAILED: ${String(err)}`);
  }

  // ── 3. Fallback config ─────────────────────────────────────────────────────
  heading('3. fallbackHeroMedia — Ken Burns config (no video, no network)');
  console.log(JSON.stringify(fallbackHeroMedia({ imagePath: samplePhoto, durationSec: 6 }), null, 2));

  heading(failures === 0 ? 'verify-media: OK' : `verify-media: ${failures} failure(s)`);
  console.log(`output dir: ${OUT_DIR}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
