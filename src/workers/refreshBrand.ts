/**
 * `refresh-brand` — re-collect a business's identity material, on demand.
 *
 * WHY IT EXISTS. Roman, on the second batch: "Чого ти не збираєш ассети
 * нормально? Фотки, логотип, брендові кольори. Демки виходять шаблонні." The
 * logo hunter and the photo miner that answer him (`src/enrichment/logoHunt.ts`,
 * `src/enrichment/photoHunt.ts`) are new, and the sixteen Patras businesses
 * that are already `production_ready` were collected under the old regex. Their
 * assets are wrong in a way no future run would fix by itself, because
 * `collect-assets` only ever runs once, chained off `enrich`.
 *
 * Re-running `enrich` for them is not an option — it deletes and rebuilds every
 * fact, and some of these businesses have a demo already built from those
 * facts. So this is the same shape as `enrich-socials` (which exists for
 * exactly the same reason): a small, idempotent, operator-triggered job that
 * ADDS evidence and never removes any.
 *
 * WHAT IT DOES NOT DO — deliberately:
 *   - no status transition. Identity material is not a state machine input.
 *   - no fact deletion. `extractBrandIdentity` rewrites only its own `brand.*`
 *     facts; every other fact is untouched.
 *   - no build. Collecting a logo does not entitle anything to rebuild a demo —
 *     that is Roman's button and his alone (CLAUDE.md invariant).
 *   - no new page captures. It mines the immutable evidence already in storage,
 *     so it costs the business's site nothing and can be run freely.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { JobPayload } from '../orchestrator/queue.js';
import { log } from '../lib/logger.js';
import { extractBrandIdentity } from '../enrichment/brandIdentity.js';
import {
  collectAssets,
  type AssetCollectionResult,
} from '../enrichment/assetCollection.js';

export interface BrandRefreshDependencies {
  collect: typeof collectAssets;
  extract: typeof extractBrandIdentity;
}

export interface BrandRefreshResult {
  collection: AssetCollectionResult;
  brand: Awaited<ReturnType<typeof extractBrandIdentity>>;
}

const DEFAULT_DEPENDENCIES: BrandRefreshDependencies = {
  collect: collectAssets,
  extract: extractBrandIdentity,
};

/**
 * Explicit refresh policy: collect once, then extract brand once even when no
 * bytes were added (logo ranking or existing evidence may still have changed).
 */
export async function refreshBrandEvidence(
  businessId: string,
  dependencies: BrandRefreshDependencies = DEFAULT_DEPENDENCIES,
): Promise<BrandRefreshResult> {
  const collection = await dependencies.collect({ businessId, imageUrls: [] });
  const brand = await dependencies.extract(businessId, {
    skipVoice: true,
    preserveVoice: true,
  });
  return { collection, brand };
}

export async function refreshBrandHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);

  const before = await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));
  const logosBefore = before.filter((a) => a.intendedUsage === 'logo').length;

  const { collection, brand } = await refreshBrandEvidence(businessId);

  const after = await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));
  const logosAfter = after.filter((a) => a.intendedUsage === 'logo');

  log.info('refresh-brand done', {
    businessId,
    photosBefore: before.length,
    photosAfter: after.length,
    assetsSaved: collection.saved,
    logosBefore,
    logosAfter: logosAfter.length,
    logoSources: logosAfter.map((a) => a.sourceUrl.slice(0, 90)),
    paletteSource: brand.paletteSource,
    primary: brand.primary?.hex ?? null,
    accent: brand.accent?.hex ?? null,
    background: brand.background?.hex ?? null,
    mood: brand.agent?.mood ?? null,
    typography: brand.agent?.typography
      ? [brand.agent.typography.family, brand.agent.typography.weight].filter(Boolean).join(' ')
      : null,
    agentConfidence: brand.agent?.confidence ?? null,
    gap: brand.gap,
  });
  if (brand.notes.length) log.warn('refresh-brand notes', { businessId, notes: brand.notes.slice(0, 6) });
}
