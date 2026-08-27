import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createInternalAuth } from '../src/api/internalAuth.js';
import {
  registerBusinessTransitionCommandRoute,
  type OperatorTransitionCommand,
} from '../src/api/businessTransitionCommands.js';
import type { BusinessTransitionResult } from '../src/orchestrator/businessStatus.js';

let passed = 0;

async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed++;
  console.log(`✅ ${label}`);
}

function appWith(
  secret: string,
  result: BusinessTransitionResult = {
    kind: 'moved',
    from: 'needs_review',
    to: 'production_ready',
  },
  capture?: (command: OperatorTransitionCommand) => void,
): Hono {
  const app = new Hono();
  registerBusinessTransitionCommandRoute(
    app,
    createInternalAuth(() => secret),
    async (command) => {
      capture?.(command);
      return result;
    },
  );
  return app;
}

async function post(app: Hono, body: unknown, key?: string) {
  const response = await app.request('/internal/business-transitions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-internal-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

await check('the endpoint fails closed and rejects invalid credentials', async () => {
  assert.equal((await post(appWith(''), {}, 'secret')).status, 503);
  assert.equal((await post(appWith('secret'), {})).status, 401);
  assert.equal((await post(appWith('secret'), {}, 'wrong')).status, 401);
});

await check('invalid ids, statuses, and missing reasons never reach the executor', async () => {
  let calls = 0;
  const app = appWith('secret', undefined, () => { calls++; });
  assert.equal((await post(app, {}, 'secret')).status, 400);
  assert.equal((await post(app, {
    businessId: 'biz', expectedStatus: 'bogus', to: 'won', reason: 'x',
  }, 'secret')).status, 400);
  assert.equal((await post(app, {
    businessId: 'biz', expectedStatus: 'discovered', to: 'won', reason: '',
  }, 'secret')).status, 400);
  assert.equal(calls, 0);
});

await check('the factory fixes actor=roman and returns the typed result', async () => {
  let captured: OperatorTransitionCommand | undefined;
  const response = await post(appWith('secret', undefined, (command) => {
    captured = command;
  }), {
    businessId: 'biz',
    expectedStatus: 'needs_review',
    to: 'production_ready',
    reason: 'approved after review',
    actor: 'attacker',
  }, 'secret');

  assert.equal(response.status, 200);
  assert.equal(response.body.result.kind, 'moved');
  assert.equal(captured?.actor, 'roman');
});

await check('a stale operator command returns its current state as a conflict', async () => {
  const response = await post(appWith('secret', {
    kind: 'conflict',
    expectedStatus: 'needs_review',
    currentStatus: 'qualified',
  }), {
    businessId: 'biz',
    expectedStatus: 'needs_review',
    to: 'rejected',
    reason: 'manual review',
  }, 'secret');

  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.result.currentStatus, 'qualified');
});

console.log(`\n🔐 BUSINESS TRANSITION COMMAND API TESTS PASSED (${passed})`);
