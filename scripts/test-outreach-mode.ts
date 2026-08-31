import assert from 'node:assert/strict';
import { resolveOutreachMode } from '../src/workers/outreach.js';

assert.equal(resolveOutreachMode('dry_run', 'dry_run'), 'dry_run');
assert.equal(resolveOutreachMode('dry_run', 'live'), 'dry_run');
assert.equal(resolveOutreachMode('live', 'dry_run'), 'dry_run');
assert.equal(resolveOutreachMode('live', 'live'), 'live');
assert.equal(resolveOutreachMode('live', null), 'dry_run');

console.log('🏭 OUTREACH MODE TESTS PASSED (5)');
