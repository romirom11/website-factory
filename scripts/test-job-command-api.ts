import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createInternalAuth } from '../src/api/internalAuth.js';
import { registerJobCommandRoute } from '../src/api/jobCommands.js';
import type { EnqueueResult } from '../src/orchestrator/workflowRunStore.js';

const accepted: EnqueueResult = {
  kind: 'accepted',
  runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runStatus: 'queued',
  attemptId: 1,
  attemptSequence: 1,
  bossJobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const duplicate: EnqueueResult = {
  kind: 'duplicate',
  runId: accepted.runId,
  runStatus: 'running',
  attemptId: 1,
  attemptSequence: 1,
  bossJobId: accepted.bossJobId,
};

function appWith(secret: string, result: EnqueueResult = accepted): Hono {
  const app = new Hono();
  registerJobCommandRoute(
    app,
    createInternalAuth(() => secret),
    async () => result,
  );
  return app;
}

async function json(app: Hono, body: unknown, key?: string): Promise<{ status: number; body: any }> {
  const response = await app.request('/internal/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== undefined ? { 'x-internal-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

let passed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

await check('missing server secret fails closed', async () => {
  const response = await json(appWith(''), {}, 'anything');
  assert.equal(response.status, 503);
});

await check('missing and invalid credentials are rejected', async () => {
  assert.equal((await json(appWith('secret'), {})).status, 401);
  assert.equal((await json(appWith('secret'), {}, 'wrong')).status, 401);
});

await check('unknown job and invalid payload are rejected before enqueue', async () => {
  const unknown = await json(appWith('secret'), { name: 'made-up', payload: {} }, 'secret');
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.message, /unknown job/i);

  const invalid = await json(appWith('secret'), { name: 'build-site', payload: {} }, 'secret');
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.message, /businessId/);
});

await check('accepted command returns the full canonical run contract', async () => {
  const response = await json(appWith('secret'), {
    name: 'build-site',
    payload: { businessId: 'e2e-api', projectId: 1, idempotencyKey: 'build:e2e-api' },
    options: { priority: 42 },
  }, 'secret');
  assert.equal(response.status, 202);
  assert.deepEqual(response.body.result, accepted);
});

await check('duplicate command is a successful canonical response', async () => {
  const response = await json(appWith('secret', duplicate), {
    name: 'daily-summary', payload: { idempotencyKey: 'summary:one' },
  }, 'secret');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.result, duplicate);
  assert.match(response.body.message, /already running/i);
});

console.log(`\n🏭 JOB COMMAND API TESTS PASSED (${passed})`);
