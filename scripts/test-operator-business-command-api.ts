import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createInternalAuth } from '../src/api/internalAuth.js';
import {
  registerOperatorBusinessCommandRoutes,
  type OperatorBusinessCommandExecutor,
} from '../src/api/operatorBusinessCommands.js';

let passed = 0;

async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed++;
  console.log(`✅ ${label}`);
}

const acceptedJob = {
  kind: 'accepted' as const,
  runId: '00000000-0000-4000-8000-000000000001',
  runStatus: 'queued' as const,
  attemptId: 1,
  attemptSequence: 1,
  bossJobId: '00000000-0000-4000-8000-000000000002',
};

function executor(
  overrides: Partial<OperatorBusinessCommandExecutor> = {},
): OperatorBusinessCommandExecutor {
  return {
    markDoNotContact: async (businessId) => ({ kind: 'blocked', businessId, blockedAddresses: 2 }),
    updateDealStage: async (businessId, state) => ({ kind: 'updated', businessId, state }),
    startBuild: async (businessId) => ({ kind: 'started', businessId, job: acceptedJob }),
    ...overrides,
  };
}

function appWith(secret: string, execute = executor()): Hono {
  const app = new Hono();
  registerOperatorBusinessCommandRoutes(app, createInternalAuth(() => secret), execute);
  return app;
}

async function post(app: Hono, path: string, body?: unknown, key?: string) {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-internal-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

await check('operator business commands fail closed without the internal credential', async () => {
  assert.equal((await post(appWith('secret'), '/internal/businesses/a/builds', undefined, 'wrong')).status, 401);
  assert.equal((await post(appWith(''), '/internal/businesses/a/deal-stage', { state: 'won' }, 'secret')).status, 503);
});

await check('invalid DNC and deal commands never reach the service', async () => {
  let calls = 0;
  const app = appWith('secret', executor({
    markDoNotContact: async () => { calls++; return { kind: 'not_found', entity: 'business' }; },
    updateDealStage: async () => { calls++; return { kind: 'not_found', entity: 'business' }; },
  }));
  assert.equal((await post(app, '/internal/businesses/a/do-not-contact', { reason: ' ' }, 'secret')).status, 400);
  assert.equal((await post(app, '/internal/businesses/a/deal-stage', { state: 'invented' }, 'secret')).status, 400);
  assert.equal(calls, 0);
});

await check('valid commands preserve normalized service results', async () => {
  const app = appWith('secret');
  const dnc = await post(app, '/internal/businesses/a/do-not-contact', { reason: ' owner asked ' }, 'secret');
  const deal = await post(app, '/internal/businesses/a/deal-stage', { state: 'proposal' }, 'secret');
  const build = await post(app, '/internal/businesses/a/builds', undefined, 'secret');
  assert.equal(dnc.status, 200);
  assert.equal(dnc.body.result.blockedAddresses, 2);
  assert.equal(deal.status, 200);
  assert.equal(deal.body.result.state, 'proposal');
  assert.equal(build.status, 202);
  assert.equal(build.body.result.job.kind, 'accepted');
});

await check('domain conflicts are explicit and retryable by the UI', async () => {
  const app = appWith('secret', executor({
    startBuild: async () => ({ kind: 'state_conflict', message: 'build already active' }),
    markDoNotContact: async () => ({ kind: 'not_found', entity: 'business' }),
  }));
  assert.equal((await post(app, '/internal/businesses/a/builds', undefined, 'secret')).status, 409);
  assert.equal((await post(app, '/internal/businesses/a/do-not-contact', { reason: 'stop' }, 'secret')).status, 404);
});

console.log(`\n🔐 OPERATOR BUSINESS COMMAND API TESTS PASSED (${passed})`);
