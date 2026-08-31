/**
 * Hero-clip generation — ffmpeg Ken Burns over a REAL business photo.
 *
 * SPEC §2.5 as amended 2026-08-22 (Roman): FlowKit and its Chrome bridge are
 * GONE. Every live-Flow bridge (FlowKit, flow-agent, gflow-cli) needs a real
 * authenticated Chrome outside a datacenter — Google's bot-detection makes
 * hosted auth infeasible, per the gflow-cli maintainer's own canary notes —
 * and «я не хочу на маку нічого мати. Втрачається сенс автономної фабрики».
 *
 * The video story is now:
 *   1. AUTONOMOUS BASELINE — this file: a deterministic Ken Burns mp4 from the
 *      hero photo via ffmpeg (no network, no browser, same input → same output),
 *      or, without ffmpeg, `fallbackHeroMedia()`: a CSS/GSAP config the builder
 *      animates in the browser with no video file at all.
 *   2. WOW PATH — a video brief on the business card: the factory writes the
 *      generation prompt + names the start frame, Roman generates in whatever
 *      tool he likes and uploads the mp4 there; `planHeroMedia` picks up the
 *      uploaded `hero_clip` asset from the DB on the next build automatically.
 *
 * Evidence rule is unchanged: the clip animates a REAL evidence photo; it never
 * invents a scene. The result is still `ai_generated` + `private_demo_only`.
 */
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

export type HeroClipSource = 'ken_burns';

export interface GenerateHeroClipOptions {
  /** Absolute path to a REAL business photo (evidence asset). Required. */
  imagePath: string;
  /** Motion description recorded in provenance; the deterministic renderer does not interpret it. */
  prompt: string;
  /** Clip length; the renderer honours it exactly. */
  durationSec?: number;
  /** Directory for the produced mp4. Created if missing. */
  outDir: string;
  fileName?: string;
}

export interface HeroClip {
  filePath: string;
  bytes: number;
  contentType: 'video/mp4';
  durationSec: number;
  source: HeroClipSource;
  prompt: string;
  /** The real business photo the clip was derived from. */
  sourceImagePath: string;
  durationMs: number;
  /** Always true — the motion is synthesised. */
  aiGenerated: true;
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.media.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
  });
}

/** True when the configured ffmpeg binary can be executed. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const res = await runFfmpeg(['-version'], 10_000);
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Deterministic Ken Burns push-in over the real photo. Same inputs => same
 * output, so the pipeline is testable offline. Returns null (never throws)
 * when ffmpeg is missing.
 */
export async function kenBurnsClip(opts: {
  imagePath: string;
  outFile: string;
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
}): Promise<{ filePath: string; bytes: number } | null> {
  const fps = opts.fps ?? 25;
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const frames = Math.max(1, Math.round(opts.durationSec * fps));

  // zoompan works on a supersampled frame to avoid the well-known pixel jitter,
  // then scales back down to the target size.
  const zoomTo = 1.18;
  const filter = [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    `zoompan=z='min(1+(${(zoomTo - 1).toFixed(4)}*on/${frames}),${zoomTo})'`
      + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      + `:d=1:s=${width}x${height}:fps=${fps}`,
    'format=yuv420p',
  ].join(',');

  const args = [
    '-y', '-loop', '1', '-i', path.resolve(opts.imagePath),
    '-vf', filter,
    '-t', String(opts.durationSec),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-movflags', '+faststart',
    '-an',
    opts.outFile,
  ];

  let res: Awaited<ReturnType<typeof runFfmpeg>>;
  try {
    res = await runFfmpeg(args, 5 * 60_000);
  } catch (err) {
    log.warn('ken burns clip: ffmpeg not runnable', { err: String(err).slice(0, 200) });
    return null;
  }
  if (res.timedOut || res.code !== 0) {
    log.warn('ken burns clip: ffmpeg failed', { code: res.code, stderr: res.stderr.slice(-300) });
    return null;
  }
  const st = await stat(opts.outFile).catch(() => null);
  if (!st || st.size === 0) return null;
  return { filePath: opts.outFile, bytes: st.size };
}

export interface KenBurnsFallback {
  kind: 'ken_burns';
  /** The real business photo to animate — no video file, no network. */
  imagePath: string | null;
  durationSec: number;
  /** CSS/GSAP-friendly transform hints; the builder applies these to a real photo. */
  transform: { fromScale: number; toScale: number; fromX: string; toX: string; easing: string };
  /** Honour prefers-reduced-motion (SPEC §2.4): render the still frame instead. */
  respectReducedMotion: true;
  reason: string;
}

/**
 * Fallback hero treatment when even ffmpeg is unavailable (SPEC §2.5). Pure
 * config — the builder animates a REAL photo in CSS/GSAP, so no external
 * network and no AI media at all. Because nothing is synthesised, the result
 * is not `ai_generated`.
 */
export function fallbackHeroMedia(opts: { imagePath?: string; durationSec?: number; reason?: string } = {}): KenBurnsFallback {
  return {
    kind: 'ken_burns',
    imagePath: opts.imagePath ? path.resolve(opts.imagePath) : null,
    durationSec: opts.durationSec ?? config.media.heroClipSeconds,
    transform: { fromScale: 1.0, toScale: 1.12, fromX: '0%', toX: '-2%', easing: 'power1.inOut' },
    respectReducedMotion: true,
    reason: opts.reason ?? 'ffmpeg unavailable; animating a real photo in the browser instead',
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Produce a hero clip from a REAL business photo — the autonomous baseline.
 * Returns null when ffmpeg is missing, in which case callers use
 * {@link fallbackHeroMedia}. An UPLOADED clip is not produced here: it enters
 * as a `hero_clip` asset row and `planHeroMedia` reuses it before ever calling
 * this function.
 */
export async function generateHeroClip(opts: GenerateHeroClipOptions): Promise<HeroClip | null> {
  const durationSec = opts.durationSec ?? config.media.heroClipSeconds;

  const imageStat = await stat(opts.imagePath).catch(() => null);
  if (!imageStat?.isFile()) {
    throw new Error(`generateHeroClip: image not found: ${opts.imagePath}`);
  }

  await mkdir(opts.outDir, { recursive: true });
  const base = opts.fileName ?? `hero-${Date.now()}`;
  const outFile = path.join(opts.outDir, `${base}.mp4`);

  const startedAt = Date.now();
  const clip = await kenBurnsClip({ imagePath: opts.imagePath, outFile, durationSec });
  if (!clip) {
    log.warn('ken burns clip unavailable (no ffmpeg); caller should use fallbackHeroMedia()', {
      ffmpegBin: config.media.ffmpegBin,
    });
    return null;
  }

  return {
    filePath: clip.filePath,
    bytes: clip.bytes,
    contentType: 'video/mp4',
    durationSec,
    source: 'ken_burns',
    prompt: opts.prompt,
    sourceImagePath: path.resolve(opts.imagePath),
    durationMs: Date.now() - startedAt,
    aiGenerated: true,
  };
}
