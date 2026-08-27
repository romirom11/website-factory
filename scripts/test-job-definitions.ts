import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  JOB_DEFINITIONS,
  JOB_NAMES,
  MANUAL_REQUEUE_JOB_NAMES,
  PHYSICAL_QUEUE_NAMES,
  REQUIRED_QUEUE_NAMES,
  getJobDefinition,
  isJobName,
  jobQueuePriority,
  validateJobDefinitions,
  validateJobPayload,
  type JobDefinition,
} from '../src/orchestrator/jobDefinitions.js';
import { ensureRequiredQueues } from '../src/orchestrator/queueReadiness.js';

let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

await check('registry is exhaustive and has one definition per logical job', async () => {
  assert.equal(JOB_DEFINITIONS.length, 19);
  assert.equal(new Set(JOB_NAMES).size, JOB_NAMES.length);

  // Source inspection keeps this registry check import-only: loading all worker
  // modules would initialize runtime settings and touch PostgreSQL.
  const mainSource = await readFile(new URL('../src/workers/main.ts', import.meta.url), 'utf8');
  const handlerBlock = /export const HANDLERS:[\s\S]*?= \{([\s\S]*?)\n\};/.exec(mainSource)?.[1] ?? '';
  const handlers = [...handlerBlock.matchAll(/^\s*'([a-z-]+)':/gm)].map((match) => match[1]!);
  assert.deepEqual(new Set(handlers), new Set(JOB_NAMES));
  assert.match(mainSource, /JOB_DEFINITIONS\.filter\(\(definition\) => definition\.workerGroup === group\)/);
});

await check('agent-backed enrichment jobs carry long expiry and group queues', () => {
  for (const name of ['enrich-socials', 'collect-assets', 'refresh-brand'] as const) {
    const definition = getJobDefinition(name);
    assert.equal(definition.agentCapability, 'subscription');
    assert.equal(definition.expireInSeconds, 90 * 60);
    assert.equal(definition.physicalQueue, `agent-${definition.workerGroup}`);
  }
});

await check('every retry, expiry and scheduling policy is explicit', () => {
  for (const definition of JOB_DEFINITIONS) {
    assert.ok(Number.isInteger(definition.retry.limit) && definition.retry.limit >= 0);
    assert.ok(Number.isInteger(definition.retry.delaySeconds) && definition.retry.delaySeconds >= 0);
    assert.ok(Number.isInteger(definition.expireInSeconds) && definition.expireInSeconds > 0);
    assert.ok(definition.schedulingClass.length > 0);
    assert.ok(definition.displayName.length > 0);
  }

  assert.deepEqual(getJobDefinition('discover').retry, { limit: 2, delaySeconds: 60 });
  assert.deepEqual(getJobDefinition('enrich').retry, { limit: 3, delaySeconds: 120 });
  assert.deepEqual(getJobDefinition('enrich-socials').retry, { limit: 1, delaySeconds: 120 });
  assert.deepEqual(getJobDefinition('refresh-brand').retry, { limit: 2, delaySeconds: 30 });
  assert.deepEqual(getJobDefinition('audit-website').retry, { limit: 3, delaySeconds: 60 });
  assert.deepEqual(getJobDefinition('build-site').retry, { limit: 1, delaySeconds: 0 });
  assert.deepEqual(getJobDefinition('send-outreach').retry, { limit: 0, delaySeconds: 0 });
});

await check('scheduling classes dominate caller priority', () => {
  assert.ok(jobQueuePriority('score-and-qa', 0) > jobQueuePriority('enrich', 999_999));
  assert.ok(jobQueuePriority('build-site', 90) > jobQueuePriority('build-site', 20));
  assert.ok(jobQueuePriority('content-and-design', 0) > jobQueuePriority('enrich-socials', 9_999));
});

await check('payload schemas accept valid scope and reject missing identifiers', () => {
  assert.deepEqual(validateJobPayload('discover', { campaignId: 'campaign-1' }), { ok: true });
  assert.deepEqual(validateJobPayload('build-site', { businessId: 'business-1', projectId: 4 }), { ok: true });
  assert.deepEqual(validateJobPayload('daily-summary', {}), { ok: true });

  assert.deepEqual(validateJobPayload('discover', {}), {
    ok: false,
    issues: ['campaignId must be a non-empty string'],
  });
  assert.deepEqual(validateJobPayload('build-site', { businessId: '' }), {
    ok: false,
    issues: ['businessId must be a non-empty string'],
  });
  assert.deepEqual(validateJobPayload('daily-summary', { idempotencyKey: '' }), {
    ok: false,
    issues: ['idempotencyKey must be a non-empty string when provided'],
  });
});

await check('unknown jobs and duplicate registry entries fail closed', () => {
  assert.equal(isJobName('not-a-job'), false);
  assert.throws(() => getJobDefinition('not-a-job'), /unknown job name/);

  const duplicate = [
    ...JOB_DEFINITIONS,
    { ...JOB_DEFINITIONS[0] },
  ] as JobDefinition[];
  assert.throws(() => validateJobDefinitions(duplicate), /duplicate job definition/);
});

await check('operator requeue choices come from the registry', () => {
  const expected = [
    'enrich', 'enrich-socials', 'refresh-brand', 'collect-assets', 'audit-website',
    'score-and-qa', 'readiness-gate', 'content-and-design', 'build-site',
    'visual-qa', 'deploy-demo', 'request-approval',
  ];
  assert.deepEqual([...MANUAL_REQUEUE_JOB_NAMES], expected);
});

await check('queue readiness creates every logical/physical queue and propagates failure', async () => {
  const created: string[] = [];
  await ensureRequiredQueues({
    createQueue: async (name: string) => { created.push(name); },
  });
  assert.deepEqual(created, [...REQUIRED_QUEUE_NAMES]);
  assert.ok(PHYSICAL_QUEUE_NAMES.includes('agent-build'));
  assert.ok(PHYSICAL_QUEUE_NAMES.includes('agent-enrich'));
  assert.ok(PHYSICAL_QUEUE_NAMES.includes('agent-core'));

  await assert.rejects(
    ensureRequiredQueues({
      createQueue: async (name: string) => {
        if (name === 'agent-build') throw new Error('queue unavailable');
      },
    }),
    /queue unavailable/,
  );
});

await check('API waits for queue readiness before binding its port', async () => {
  const source = await readFile(new URL('../src/api/server.ts', import.meta.url), 'utf8');
  const ensureAt = source.indexOf('await ensureQueues()');
  const serveAt = source.indexOf('serve({ fetch: app.fetch');
  assert.ok(ensureAt >= 0, 'startApi must await ensureQueues()');
  assert.ok(serveAt > ensureAt, 'the HTTP server must bind only after queues are ready');
});

console.log(`\n🏭 JOB DEFINITIONS TESTS PASSED (${passed})`);
