import assert from 'node:assert/strict';
import { evaluateLayoutQuality, type LayoutQualityMetrics } from '../src/build/layoutQuality.js';

const healthy: LayoutQualityMetrics = {
  pageHeight: 5_000,
  inkElements: 80,
  inkPer1000px: 16,
  textChars: 2_000,
  evidenceMediaAreaRatio: 0.16,
};

assert.deepEqual(evaluateLayoutQuality({ viewport: 'desktop', metrics: healthy, hasRealPhotos: true }), []);
console.log('✅ balanced desktop layout passes');

const thin = evaluateLayoutQuality({
  viewport: 'desktop',
  metrics: { ...healthy, inkElements: 50, inkPer1000px: 10 },
  hasRealPhotos: true,
});
assert.equal(thin.filter((issue) => issue.category === 'spacing-rhythm').length, 1);
console.log('✅ low ink density is blocked');

const tooTall = evaluateLayoutQuality({
  viewport: 'desktop',
  metrics: { ...healthy, pageHeight: 7_276, inkPer1000px: 16, textChars: 1_680 },
  hasRealPhotos: true,
});
assert.equal(tooTall.filter((issue) => issue.category === 'spacing-rhythm').length, 1);
console.log('✅ excessive page-height/content ratio is blocked independently of ink count');

const tinyPhotos = evaluateLayoutQuality({
  viewport: 'desktop',
  metrics: { ...healthy, evidenceMediaAreaRatio: 0.06 },
  hasRealPhotos: true,
});
assert.equal(tinyPhotos.filter((issue) => issue.category === 'photo-treatment').length, 1);
console.log('✅ token use of available real photos is blocked');

const noPhotos = evaluateLayoutQuality({
  viewport: 'desktop',
  metrics: { ...healthy, evidenceMediaAreaRatio: 0 },
  hasRealPhotos: false,
});
assert.equal(noPhotos.filter((issue) => issue.category === 'photo-treatment').length, 0);
console.log('✅ businesses without evidence photos are not forced to invent imagery');

assert.deepEqual(evaluateLayoutQuality({
  viewport: 'mobile',
  metrics: { ...healthy, inkPer1000px: 1, evidenceMediaAreaRatio: 0 },
  hasRealPhotos: true,
}), []);
console.log('✅ responsive stacking does not trigger desktop density thresholds');

console.log('\n🧪 LAYOUT QUALITY TEST PASSED');
