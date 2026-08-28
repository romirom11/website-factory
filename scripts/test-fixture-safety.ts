import assert from 'node:assert/strict';
import { assertFixtureId, assertFixtureIds } from './e2e/safety.js';

assert.equal(assertFixtureId('e2e-safe-business'), 'e2e-safe-business');
assert.deepEqual(assertFixtureIds(['e2e-one', 'e2e-two']), ['e2e-one', 'e2e-two']);
assert.throws(
  () => assertFixtureId('gr-patras-real-salon', 'business'),
  /refusing to mutate non-fixture business/,
);
assert.throws(
  () => assertFixtureIds(['e2e-safe', 'legacy-real-business'], 'business'),
  /refusing to mutate non-fixture business/,
);

console.log('🏭 FIXTURE SAFETY TESTS PASSED (4)');
