import assert from 'node:assert/strict';
import type { AssetCollectionResult } from '../src/enrichment/assetCollection.js';
import { collectAssetsForPipeline } from '../src/workers/assets.js';
import { refreshBrandEvidence } from '../src/workers/refreshBrand.js';

let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

function collection(overrides: Partial<AssetCollectionResult> = {}): AssetCollectionResult {
  return {
    offered: 0,
    saved: 0,
    logosSaved: 0,
    duplicate: 0,
    skippedSmall: 0,
    failed: 0,
    blocked: 0,
    minedLogos: 0,
    minedPhotos: 0,
    hasLogo: false,
    ...overrides,
  };
}

const brandResult = {
  paletteSource: 'logo',
  primary: { hex: '#123456' },
  accent: { hex: '#abcdef' },
  background: null,
  agent: null,
  gap: null,
  notes: [],
};

await check('pipeline collection refreshes brand once only when assets changed', async () => {
  let collections = 0;
  let extractions = 0;
  await collectAssetsForPipeline({ businessId: 'changed' }, {
    collect: async () => { collections++; return collection({ saved: 2 }); },
    refreshBrand: (async () => { extractions++; return brandResult; }) as never,
  });
  assert.equal(collections, 1);
  assert.equal(extractions, 1);

  await collectAssetsForPipeline({ businessId: 'unchanged' }, {
    collect: async () => { collections++; return collection({ saved: 0 }); },
    refreshBrand: (async () => { extractions++; return brandResult; }) as never,
  });
  assert.equal(collections, 2);
  assert.equal(extractions, 1);
});

for (const scenario of [
  { label: 'new files', result: collection({ saved: 3, logosSaved: 1, hasLogo: true }) },
  { label: 'no new files', result: collection({ saved: 0 }) },
  { label: 'changed logo ranking without a new file', result: collection({ saved: 0, hasLogo: true }) },
]) {
  await check(`refresh-brand runs collection and extraction once for ${scenario.label}`, async () => {
    let collections = 0;
    let extractions = 0;
    const result = await refreshBrandEvidence('refresh-proof', {
      collect: async () => { collections++; return scenario.result; },
      extract: (async () => { extractions++; return brandResult; }) as never,
    });
    assert.equal(collections, 1);
    assert.equal(extractions, 1);
    assert.equal(result.collection, scenario.result);
    assert.equal(result.brand, brandResult);
  });
}

console.log(`\n🏭 BRAND REFRESH FLOW TESTS PASSED (${passed})`);
