import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createInternalAuth } from '../src/api/internalAuth.js';
import {
  registerOutreachDecisionCommandRoutes,
  type OutreachDecisionExecutor,
} from '../src/api/outreachDecisionCommands.js';

let passed = 0;

async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed++;
  console.log(`✅ ${label}`);
}

function appWith(secret: string, execute: OutreachDecisionExecutor): Hono {
  const app = new Hono();
  registerOutreachDecisionCommandRoutes(app, createInternalAuth(() => secret), execute);
  return app;
}

const acceptedJob = {
  kind: 'accepted' as const,
  runId: '00000000-0000-4000-8000-000000000001',
  runStatus: 'queued' as const,
  attemptId: 1,
  attemptSequence: 1,
  bossJobId: '00000000-0000-4000-8000-000000000002',
};

function executor(overrides: Partial<OutreachDecisionExecutor> = {}): OutreachDecisionExecutor {
  return {
    approve: async () => ({ kind: 'approved', businessId: 'e2e-business', job: acceptedJob }),
    reject: async () => ({ kind: 'rejected', businessId: 'e2e-business' }),
    confirmManualSend: async () => ({ kind: 'confirmed', businessId: 'e2e-business', followups: [] }),
    ...overrides,
  };
}

async function post(app: Hono, path: string, body?: unknown, key?: string) {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-internal-key': key } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as any };
}

await check('decision endpoints fail closed without the internal credential', async () => {
  const app = appWith('secret', executor());
  assert.equal((await post(app, '/internal/outreach-approvals/1/decisions', {}, 'wrong')).status, 401);
  assert.equal((await post(appWith('', executor()), '/internal/outreach-approvals/1/manual-sent', undefined, 'secret')).status, 503);
});

await check('invalid ids, decisions, and drafts never reach the service', async () => {
  let calls = 0;
  const app = appWith('secret', executor({
    approve: async () => { calls++; return { kind: 'not_found', entity: 'approval' }; },
  }));
  assert.equal((await post(app, '/internal/outreach-approvals/nope/decisions', {}, 'secret')).status, 400);
  assert.equal((await post(app, '/internal/outreach-approvals/1/decisions', { decision: 'ship' }, 'secret')).status, 400);
  assert.equal((await post(app, '/internal/outreach-approvals/1/decisions', {
    decision: 'approve', channel: 'carrier-pigeon', toAddress: 'x', body: 'x',
  }, 'secret')).status, 400);
  assert.equal(calls, 0);
});

await check('approval returns the atomic queue result and normalizes draft input', async () => {
  let captured: unknown;
  const app = appWith('secret', executor({
    approve: async (input) => {
      captured = input;
      return { kind: 'approved', businessId: 'e2e-business', job: acceptedJob };
    },
  }));
  const response = await post(app, '/internal/outreach-approvals/7/decisions', {
    decision: 'approve', channel: 'email', toAddress: ' owner@example.test ',
    subject: ' Demo ', body: ' Hello ',
  }, 'secret');
  assert.equal(response.status, 202);
  assert.equal(response.body.result.job.kind, 'accepted');
  assert.deepEqual(captured, {
    approvalId: 7,
    channel: 'email',
    toAddress: 'owner@example.test',
    subject: 'Demo',
    body: 'Hello',
  });
});

await check('domain conflicts preserve typed HTTP outcomes', async () => {
  const conflict = appWith('secret', executor({
    approve: async () => ({ kind: 'already_decided', decision: 'approved' }),
    confirmManualSend: async () => ({ kind: 'not_found', entity: 'message' }),
  }));
  assert.equal((await post(conflict, '/internal/outreach-approvals/1/decisions', {
    decision: 'approve', channel: 'email', toAddress: 'owner@example.test', body: 'Hello',
  }, 'secret')).status, 409);
  assert.equal((await post(conflict, '/internal/outreach-approvals/1/manual-sent', undefined, 'secret')).status, 404);

  const idempotent = appWith('secret', executor({
    confirmManualSend: async () => ({ kind: 'already_confirmed', state: 'sent' }),
  }));
  const replay = await post(idempotent, '/internal/outreach-approvals/1/manual-sent', undefined, 'secret');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok, true);
});

console.log(`\n🔐 OUTREACH DECISION COMMAND API TESTS PASSED (${passed})`);
