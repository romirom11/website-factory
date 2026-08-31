/** Stage 5 worker: explicit collection, brand-refresh and barrier policies. */
import { extractBrandIdentity } from '../enrichment/brandIdentity.js';
import {
  collectAssets,
  type AssetCollectionInput,
  type AssetCollectionResult,
} from '../enrichment/assetCollection.js';
import { prepareEnrichmentBranch } from '../orchestrator/enrichmentBarrierRuntime.js';
import type { JobPayload } from '../orchestrator/queue.js';
import { log } from '../lib/logger.js';

export { dimsFromBuffer, upsizeGoogleImage } from '../enrichment/assetCollection.js';

type BrandExtractor = typeof extractBrandIdentity;

export interface AssetCollectionPolicyDependencies {
  collect: (input: AssetCollectionInput) => Promise<AssetCollectionResult>;
  refreshBrand: BrandExtractor;
}

const DEFAULT_DEPENDENCIES: AssetCollectionPolicyDependencies = {
  collect: collectAssets,
  refreshBrand: extractBrandIdentity,
};

/** Pipeline policy: refresh the palette once, only when collection changed assets. */
export async function collectAssetsForPipeline(
  input: AssetCollectionInput,
  dependencies: AssetCollectionPolicyDependencies = DEFAULT_DEPENDENCIES,
): Promise<AssetCollectionResult> {
  const result = await dependencies.collect(input);
  if (result.saved > 0) {
    try {
      const brand = await dependencies.refreshBrand(input.businessId, {
        skipVoice: true,
        preserveVoice: true,
      });
      log.info('brand palette refreshed after asset collection', {
        businessId: input.businessId,
        paletteSource: brand.paletteSource,
        primary: brand.primary?.hex ?? null,
        accent: brand.accent?.hex ?? null,
      });
    } catch (error) {
      log.warn('brand refresh after assets failed', {
        businessId: input.businessId,
        error: String(error).slice(0, 200),
      });
    }
  }
  return result;
}

export async function collectAssetsHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const { barrier, runId, authorization } = await prepareEnrichmentBranch(
    payload,
    businessId,
    'assets',
  );
  if (authorization !== 'run') {
    log.info('asset collection skipped for inactive enrichment branch', {
      businessId,
      enrichmentRunId: runId,
      authorization,
    });
    return;
  }
  await collectAssetsForPipeline({
    businessId,
    imageUrls: (payload.imageUrls ?? []) as unknown[],
  });

  const result = await barrier.completeBranch({
    runId,
    businessId,
    branch: 'assets',
  });
  log.info('asset enrichment branch settled', { businessId, result: result.kind });
}
