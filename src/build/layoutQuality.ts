import type { QaIssue } from './schemas.js';

export interface LayoutQualityMetrics {
  pageHeight: number;
  inkElements: number;
  inkPer1000px: number;
  textChars: number;
  evidenceMediaAreaRatio: number;
}

export interface LayoutQualityInput {
  viewport: string;
  metrics: LayoutQualityMetrics;
  hasRealPhotos: boolean;
}

const MIN_DESKTOP_INK_PER_1000_PX = 14;
const MIN_EVIDENCE_MEDIA_AREA_RATIO = 0.08;
const MIN_PAGE_HEIGHT_FOR_RATIO_GATE = 4_500;
const MIN_TEXT_FOR_RATIO_GATE = 800;
const MAX_PAGE_HEIGHT_PER_TEXT_CHAR = 4;

/**
 * Deterministic layout-density gates shared by the production QA worker and
 * fast regression tests. They intentionally run on desktop only: responsive
 * stacking changes mobile page height without changing the amount of content.
 */
export function evaluateLayoutQuality(input: LayoutQualityInput): QaIssue[] {
  if (input.viewport !== 'desktop') return [];

  const { metrics } = input;
  const issues: QaIssue[] = [];
  const pxPerTextChar = metrics.pageHeight / Math.max(1, metrics.textChars);
  const excessiveHeightForCopy = metrics.pageHeight >= MIN_PAGE_HEIGHT_FOR_RATIO_GATE
    && metrics.textChars >= MIN_TEXT_FOR_RATIO_GATE
    && pxPerTextChar > MAX_PAGE_HEIGHT_PER_TEXT_CHAR;

  if (metrics.inkPer1000px < MIN_DESKTOP_INK_PER_1000_PX || excessiveHeightForCopy) {
    issues.push({
      severity: 'medium',
      category: 'spacing-rhythm',
      viewport: input.viewport,
      issue: `Content density is thin: ${metrics.inkElements} text/media elements over a `
        + `${metrics.pageHeight}px page (${metrics.inkPer1000px} per 1000px, `
        + `${metrics.textChars} characters, ${pxPerTextChar.toFixed(2)}px per text character). `
        + 'The page is mostly padding, which reads as unfinished rather than as confident whitespace.',
      fix: 'Either cut the page height (tighten section padding to a 3-step scale) or give sparse sections real content from the snapshot. Whitespace should frame something.',
    });
  }

  if (input.hasRealPhotos && metrics.evidenceMediaAreaRatio < MIN_EVIDENCE_MEDIA_AREA_RATIO) {
    issues.push({
      severity: 'medium',
      category: 'photo-treatment',
      viewport: input.viewport,
      issue: `Real business photography occupies only ${(metrics.evidenceMediaAreaRatio * 100).toFixed(1)}% `
        + `of the ${metrics.pageHeight}px page (minimum ${(MIN_EVIDENCE_MEDIA_AREA_RATIO * 100).toFixed(0)}%). `
        + 'Evidence photos are present but treated as decoration instead of carrying a section.',
      fix: 'Give at least one real evidence photo section-scale presence: a full-bleed hero, editorial split, or substantial gallery composition. Do not replace it with generated imagery.',
    });
  }

  return issues;
}
