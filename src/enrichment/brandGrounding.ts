/**
 * Pure brand-grounding contract shared by the agent and its unit tests.
 *
 * Keep this module free of DB, storage, browser and agent-runtime imports. The
 * production adapter owns I/O; these functions only validate model claims
 * against already-decoded evidence and render the workspace manifest.
 */
import path from 'node:path';
import { fromHex, type PaletteEntry, type Rgb } from './colorExtract.js';

/** One evidence file as the agent sees it and as grounding resolves it. */
export interface BrandInput {
  file: string;
  what: string;
  sourceId: number;
  bucket: 'raw' | 'assets';
  objectKey: string;
  contentType: string;
}

/**
 * Maximum Euclidean RGB distance between a claimed hex and a real palette
 * colour. This matches the build rubric's "same colour" tolerance.
 */
export const GROUNDING_TOLERANCE_RGB = 60;

/** Colours genuinely present in one file, as the grounding check sees them. */
export interface FileColors {
  file: string;
  palette: PaletteEntry[];
}

export interface GroundingVerdict {
  grounded: boolean;
  nearestHex: string | null;
  distance: number | null;
  reason: string | null;
}

/** Validate that a claimed colour is present in the exact evidence file cited. */
export function checkGrounding(
  claim: { hex: string; file: string },
  files: readonly FileColors[],
  tolerance = GROUNDING_TOLERANCE_RGB,
): GroundingVerdict {
  const rgb = fromHex(claim.hex);
  if (!rgb) {
    return { grounded: false, nearestHex: null, distance: null, reason: `"${claim.hex}" is not a hex colour` };
  }

  const wanted = normalizedBasename(claim.file);
  const hit = files.find((file) => normalizedBasename(file.file) === wanted);
  if (!hit) {
    return {
      grounded: false,
      nearestHex: null,
      distance: null,
      reason: `cites "${claim.file}", which is not a file in the workspace`,
    };
  }
  if (hit.palette.length === 0) {
    return {
      grounded: false,
      nearestHex: null,
      distance: null,
      reason: `"${hit.file}" yielded no colours to compare against`,
    };
  }

  let nearest: { hex: string; distance: number } | null = null;
  for (const colour of hit.palette) {
    const actual = fromHex(colour.hex);
    if (!actual) continue;
    const distance = rgbDistance(rgb, actual);
    if (!nearest || distance < nearest.distance) nearest = { hex: colour.hex, distance };
  }
  if (!nearest) {
    return {
      grounded: false,
      nearestHex: null,
      distance: null,
      reason: `"${hit.file}" yielded no comparable colours`,
    };
  }

  const distance = Number(nearest.distance.toFixed(1));
  if (nearest.distance <= tolerance) {
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

/** Resolve the evidence source behind a filename cited by the agent. */
export function sourceIdForFile(file: string, inputs: readonly BrandInput[]): number | null {
  const wanted = normalizedBasename(file);
  const hit = inputs.find((input) => normalizedBasename(input.file) === wanted);
  return hit?.sourceId ?? null;
}

/** Render the complete, filename-addressed evidence manifest the agent reads. */
export function renderInputsMd(businessName: string, inputs: readonly BrandInput[]): string {
  return [
    `# Brand material for ${businessName}`,
    '',
    'Every file below was published by this business and captured as evidence. There is nothing',
    'else. Read each one before answering, and cite files by the exact names in this list.',
    '',
    ...inputs.map((input) => `- \`${input.file}\` — ${input.what}`),
    '',
    'When you cite a colour, name the file you read it off. Code re-derives every hex from the',
    'file you cite and drops the ones that are not really there.',
  ].join('\n');
}

function normalizedBasename(file: string): string {
  return path.basename(file.trim()).toLowerCase();
}
