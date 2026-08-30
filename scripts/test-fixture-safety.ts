import assert from 'node:assert/strict';
import { assertFixtureId, assertFixtureIds } from './e2e/safety.js';
import { assertFactoryTaskIsolated } from './e2e/isolation.js';

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

const previousIsolation = process.env.E2E_FACTORY_ISOLATED;
try {
  delete process.env.E2E_FACTORY_ISOLATED;
  assert.throws(
    () => assertFactoryTaskIsolated('fixture-test'),
    /requires the isolated Compose wrapper/,
  );
  process.env.E2E_FACTORY_ISOLATED = 'true';
  assert.doesNotThrow(() => assertFactoryTaskIsolated('fixture-test'));
} finally {
  if (previousIsolation === undefined) delete process.env.E2E_FACTORY_ISOLATED;
  else process.env.E2E_FACTORY_ISOLATED = previousIsolation;
}

console.log('🏭 FIXTURE SAFETY TESTS PASSED (6)');
