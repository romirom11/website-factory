/**
 * Real PostgreSQL + pg-boss proof for subscription-limit continuation.
 * A continuation is a new physical attempt inside the same logical run and is
 * created exactly once even when two recovery paths race.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { WorkflowRunStore } from '../src/orchestrator/workflowRunStore.js';
import { withDisposableFactoryDatabase } from './lib/disposableFactoryDatabase.js';

let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

await withDisposableFactoryDatabase(async ({ pool, db, boss }) => {
  const store = new WorkflowRunStore(pool, boss);
  const key = `rate-limit:${randomUUID()}`;
  const first = await store.enqueue({
    name: 'build-site',
    payload: {
      businessId: `e2e-${randomUUID()}`,
      projectId: 1,
      idempotencyKey: key,
    },
  });
  assert.equal(first.kind, 'accepted');

  await db.update(schema.workflowJobs)
    .set({ status: 'running', attempts: 1, startedAt: new Date() })
    .where(eq(schema.workflowJobs.id, first.attemptId));
  await db.update(schema.workflowJobRuns)
    .set({ status: 'running', updatedAt: new Date() })
    .where(eq(schema.workflowJobRuns.id, first.runId));

  const nextAttemptAt = new Date(Date.now() + 60_000);
  const continuationInput = {
    bossJobId: first.bossJobId,
    retryAfterMs: 60_000,
    nextAttemptAt,
    errorDetail: `subscription limit (five_hour); resumes ${nextAttemptAt.toISOString()}`,
  };

  const results = await Promise.all([
    store.continueAfterRateLimit(continuationInput),
    store.continueAfterRateLimit(continuationInput),
  ]);

  await check('racing continuations schedule one successor', () => {
    assert.equal(results.filter((result) => result.kind === 'scheduled').length, 1);
    assert.equal(results.filter((result) => result.kind === 'existing').length, 1);
    assert.equal(new Set(results.map((result) => result.kind === 'legacy' ? null : result.bossJobId)).size, 1);
  });

  const [run] = await db.select().from(schema.workflowJobRuns)
    .where(eq(schema.workflowJobRuns.id, first.runId));
  const attempts = await db.select().from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.runId, first.runId))
    .orderBy(asc(schema.workflowJobs.attemptSequence));

  await check('continuation stays on the same logical run', () => {
    assert.equal(run?.id, first.runId);
    assert.equal(run?.status, 'retry_wait');
    assert.equal(run?.currentAttemptSequence, 2);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.attemptSequence), [1, 2]);
    assert.equal(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size, 1);
  });

  await check('rate limit does not consume a failure attempt', () => {
    assert.equal(attempts[0]?.status, 'retry_wait');
    assert.equal(attempts[0]?.attempts, 0);
    assert.equal(attempts[0]?.errorCode, 'RATE_LIMITED');
    assert.equal(attempts[1]?.status, 'queued');
    assert.equal(attempts[1]?.attempts, 0);
    assert.equal(attempts[1]?.nextAttemptAt?.getTime(), nextAttemptAt.getTime());
    assert.equal(attempts.some((attempt) => attempt.status === 'failed'), false);
  });

  await check('application and pg-boss ledgers contain the same two attempts', async () => {
    const ids = attempts.map((attempt) => attempt.bossJobId);
    const result = await pool.query<{ id: string }>(
      `select id::text from pgboss.job where id = any($1::uuid[]) order by id`,
      [ids],
    );
    assert.equal(result.rows.length, 2);
  });

  await check('an unreachable runner pauses the same way, under its own code', async () => {
    const down = await store.enqueue({
      name: 'content-and-design',
      payload: { businessId: `e2e-${randomUUID()}`, idempotencyKey: `runner-down:${randomUUID()}` },
    });
    assert.equal(down.kind, 'accepted');
    await db.update(schema.workflowJobs)
      .set({ status: 'running', attempts: 1, startedAt: new Date() })
      .where(eq(schema.workflowJobs.id, down.attemptId));
    await db.update(schema.workflowJobRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(schema.workflowJobRuns.id, down.runId));
    const resumesAt = new Date(Date.now() + 60_000);
    const result = await store.continueAfterRateLimit({
      bossJobId: down.bossJobId,
      retryAfterMs: 60_000,
      nextAttemptAt: resumesAt,
      errorDetail: `runner unavailable (fetch failed); resumes ${resumesAt.toISOString()}`,
      errorCode: 'RUNNER_UNAVAILABLE',
    });
    assert.equal(result.kind, 'scheduled');
    const [paused] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, down.attemptId));
    assert.equal(paused?.status, 'retry_wait');
    assert.equal(paused?.errorCode, 'RUNNER_UNAVAILABLE');
    assert.equal(paused?.attempts, 0);
    const [downRun] = await db.select().from(schema.workflowJobRuns)
      .where(eq(schema.workflowJobRuns.id, down.runId));
    assert.equal(downRun?.status, 'retry_wait');
  });

  await check('a late rate-limit result cannot create work for a cancelled run', async () => {
    const staleKey = `stale-rate-limit:${randomUUID()}`;
    const stale = await store.enqueue({
      name: 'build-site',
      payload: {
        businessId: `e2e-${randomUUID()}`,
        projectId: 2,
        idempotencyKey: staleKey,
      },
    });
    assert.equal(stale.kind, 'accepted');
    await db.update(schema.workflowJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(schema.workflowJobs.id, stale.attemptId));
    await db.update(schema.workflowJobRuns)
      .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.workflowJobRuns.id, stale.runId));
    const before = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.runId, stale.runId));
    const result = await store.continueAfterRateLimit({
      ...continuationInput,
      bossJobId: stale.bossJobId,
    });
    const after = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.runId, stale.runId));
    assert.equal(result.kind, 'stale');
    assert.equal(after.length, before.length);
  });

  console.log(`\n🧪 RATE-LIMIT REQUEUE TEST PASSED (${passed})`);
});
