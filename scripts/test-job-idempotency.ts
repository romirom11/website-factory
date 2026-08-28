/**
 * Real PostgreSQL + pg-boss integration proof for logical-run idempotency.
 *
 * The script creates and drops a dedicated temporary database. It refuses a
 * remote server unless JOB_TEST_ALLOW_REMOTE=1 is explicit, so the factory's
 * live database is never used as test state.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { getJobDefinition } from '../src/orchestrator/jobDefinitions.js';
import {
  WorkflowRunStore,
  type BossSender,
  type EnqueueCommand,
} from '../src/orchestrator/workflowRunStore.js';
import { withDisposableFactoryDatabase } from './lib/disposableFactoryDatabase.js';

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'retry_wait'] as const;
let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

function command(key: string, name: EnqueueCommand['name'] = 'daily-summary'): EnqueueCommand {
  return name === 'daily-summary'
    ? { name, payload: { idempotencyKey: key, silent: true } }
    : {
        name,
        payload: {
          businessId: `e2e-${key.replaceAll(':', '-')}`,
          idempotencyKey: key,
          projectId: 1,
        },
      };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for pg-boss retry');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await withDisposableFactoryDatabase(async ({ pool, db: testDb, boss }) => {
  const count = async (sqlText: string, values: unknown[] = []): Promise<number> => {
    const result = await pool.query<{ count: string }>(sqlText, values);
    return Number(result.rows[0]?.count ?? 0);
  };
  const store = new WorkflowRunStore(pool, boss);

  await check('100 concurrent commands create one canonical active run and attempt', async () => {
    const key = `parallel:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 100 }, () => store.enqueue(command(key))));
    const accepted = results.filter((result) => result.kind === 'accepted');
    const duplicates = results.filter((result) => result.kind === 'duplicate');

    assert.equal(accepted.length, 1);
    assert.equal(duplicates.length, 99);
    assert.equal(new Set(results.map((result) => result.runId)).size, 1);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = $1 and idempotency_key = $2 and status in ('queued', 'running', 'retry_wait')`,
      ['daily-summary', key],
    ), 1);
    assert.equal(await count(
      `select count(*) from workflow_jobs where run_id = $1`,
      [results[0]!.runId],
    ), 1);
    const suppression = await pool.query<{
      duplicate_suppressions: number;
      last_duplicate_at: Date | null;
    }>(
      `select duplicate_suppressions, last_duplicate_at
       from workflow_job_runs where id = $1`,
      [results[0]!.runId],
    );
    assert.equal(suppression.rows[0]?.duplicate_suppressions, 99);
    assert.ok(suppression.rows[0]?.last_duplicate_at instanceof Date);
    assert.equal(await count(
      `select count(*) from pgboss.job where id = $1`,
      [accepted[0]!.bossJobId],
    ), 1);
  });

  await check('different idempotency keys remain independently enqueueable', async () => {
    const prefix = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.enqueue(command(`different:${prefix}:${index}`))),
    );
    assert.equal(results.every((result) => result.kind === 'accepted'), true);
    assert.equal(new Set(results.map((result) => result.runId)).size, 20);
  });

  await check('failure before pg-boss send leaves no logical run or attempt', async () => {
    const key = `before-send:${randomUUID()}`;
    const failingBoss: BossSender = {
      send: async () => { throw new Error('injected before send'); },
    };
    const failingStore = new WorkflowRunStore(pool, failingBoss);
    await assert.rejects(failingStore.enqueue(command(key)), /injected before send/);
    assert.equal(await count(`select count(*) from workflow_job_runs where idempotency_key = $1`, [key]), 0);
    assert.equal(await count(`select count(*) from workflow_jobs where idempotency_key = $1`, [key]), 0);
  });

  await check('failure after pg-boss send rolls back both schemas', async () => {
    const key = `after-send:${randomUUID()}`;
    let insertedBossId: string | undefined;
    const failingBoss: BossSender = {
      send: async (name, payload, options) => {
        insertedBossId = String(options.id);
        await boss.send(name, payload, options);
        throw new Error('injected after send');
      },
    };
    const failingStore = new WorkflowRunStore(pool, failingBoss);
    await assert.rejects(failingStore.enqueue(command(key)), /injected after send/);
    assert.equal(await count(`select count(*) from workflow_job_runs where idempotency_key = $1`, [key]), 0);
    assert.equal(await count(`select count(*) from workflow_jobs where idempotency_key = $1`, [key]), 0);
    assert.equal(await count(`select count(*) from pgboss.job where id = $1`, [insertedBossId]), 0);
  });

  await check('a domain mutation commits with its workflow run and pg-boss job', async () => {
    const key = `domain-success:${randomUUID()}`;
    const campaignId = `campaign-${randomUUID()}`;
    const result = await store.enqueue(command(key), async (tx) => {
      await tx.insert(schema.campaigns).values({
        id: campaignId,
        country: 'GR',
        city: 'Patras',
        niche: 'test',
        language: 'el',
        queries: ['test'],
        geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
      });
    });
    assert.equal(result.kind, 'accepted');
    assert.equal(await count(`select count(*) from campaigns where id = $1`, [campaignId]), 1);
    assert.equal(await count(`select count(*) from workflow_job_runs where id = $1`, [result.runId]), 1);
    assert.equal(await count(`select count(*) from pgboss.job where id = $1`, [result.bossJobId]), 1);
  });

  await check('a pg-boss failure rolls back the related domain mutation too', async () => {
    const key = `domain-rollback:${randomUUID()}`;
    const campaignId = `campaign-${randomUUID()}`;
    const failingBoss: BossSender = {
      send: async (name, payload, options) => {
        await boss.send(name, payload, options);
        throw new Error('domain mutation rollback proof');
      },
    };
    const failingStore = new WorkflowRunStore(pool, failingBoss);
    await assert.rejects(
      failingStore.enqueue(command(key), async (tx) => {
        await tx.insert(schema.campaigns).values({
          id: campaignId,
          country: 'GR',
          city: 'Patras',
          niche: 'test',
          language: 'el',
          queries: ['test'],
          geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
        });
      }),
      /domain mutation rollback proof/,
    );
    assert.equal(await count(`select count(*) from campaigns where id = $1`, [campaignId]), 0);
    assert.equal(await count(`select count(*) from workflow_job_runs where idempotency_key = $1`, [key]), 0);
  });

  await check('a terminal run permits a new logical run with the same key', async () => {
    const key = `terminal:${randomUUID()}`;
    const first = await store.enqueue(command(key));
    assert.equal(first.kind, 'accepted');
    await testDb.update(schema.workflowJobRuns)
      .set({ status: 'succeeded', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.workflowJobRuns.id, first.runId));

    const second = await store.enqueue(command(key));
    assert.equal(second.kind, 'accepted');
    assert.notEqual(second.runId, first.runId);
    const active = await testDb.select().from(schema.workflowJobRuns).where(and(
      eq(schema.workflowJobRuns.idempotencyKey, key),
      inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
    ));
    assert.equal(active.length, 1);
  });

  await check('pg-boss automatic retry keeps one physical attempt id', async () => {
    const key = `retry:${randomUUID()}`;
    const enqueued = await store.enqueue(command(key, 'build-site'));
    assert.equal(enqueued.kind, 'accepted');
    const physical = await pool.query<{
      name: string;
      logical_name: string | null;
    }>(
      `select name, data->>'__factoryJobName' as logical_name
       from pgboss.job where id = $1`,
      [enqueued.bossJobId],
    );
    assert.deepEqual(physical.rows[0], {
      name: 'agent-build',
      logical_name: 'build-site',
    });

    const seenIds: string[] = [];
    let calls = 0;
    const workerId = await boss.work(
      getJobDefinition('build-site').physicalQueue,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
      for (const job of jobs) {
        seenIds.push(job.id);
        calls++;
        if (calls === 1) throw new Error('retry once');
      }
      },
    );
    await waitUntil(() => calls >= 2);
    await boss.offWork({ id: workerId });

    assert.deepEqual(new Set(seenIds), new Set([enqueued.bossJobId]));
    assert.equal(await count(`select count(*) from workflow_jobs where run_id = $1`, [enqueued.runId]), 1);
  });

  console.log(`\n🏭 JOB IDEMPOTENCY TESTS PASSED (${passed})`);
});
