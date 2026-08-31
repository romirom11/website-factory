/** Real-Postgres regression proof for startup reconciliation and legacy adoption. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { withDisposableFactoryDatabase } from './lib/disposableFactoryDatabase.js';

let passed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

await withDisposableFactoryDatabase(async ({ connectionString, pool, db, boss }) => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;
  const [{ reconcileOnStartup, requeueOrphanedBuildJobs }, { processJob }, runtimeDb] = await Promise.all([
    import('../src/orchestrator/reconcile.js'),
    import('../src/orchestrator/queue.js'),
    import('../src/db/client.js'),
  ]);

  try {

  const campaignId = 'reconcile-campaign';
  await db.insert(schema.campaigns).values({
    id: campaignId,
    country: 'gr', city: 'Reconcile', niche: 'beauty', language: 'el',
    queries: ['beauty'], geofence: { lat: 38, lng: 21, radiusKm: 1 }, targetCount: 10,
  });

  const business = async (id: string, status = 'needs_review'): Promise<string> => {
    await db.insert(schema.businesses).values({
      id, campaignId, name: id, normalizedName: id, status,
    });
    return id;
  };

  const bossJob = async (
    name: string,
    data: Record<string, unknown>,
    state: 'created' | 'retry' | 'active' = 'created',
  ): Promise<string> => {
    const result = await pool.query<{ id: string }>(
      `insert into pgboss.job (name, data, state, started_on)
       values ($1, $2::jsonb, $3::pgboss.job_state,
         case when $3::text = 'active' then now() else null end)
       returning id`,
      [name, JSON.stringify(data), state],
    );
    return result.rows[0]!.id;
  };

  const legacyAttempt = async (input: {
    businessId: string;
    bossJobId: string | null;
    key: string;
    status?: string;
  }): Promise<number> => {
    const [row] = await db.insert(schema.workflowJobs).values({
      businessId: input.businessId,
      campaignId,
      bossJobId: input.bossJobId,
      jobType: 'enrich',
      idempotencyKey: input.key,
      payload: {
        businessId: input.businessId,
        campaignId,
        idempotencyKey: input.key,
      },
      status: input.status ?? 'queued',
    }).returning({ id: schema.workflowJobs.id });
    return row!.id;
  };

  const ghostBusiness = await business('reconcile-ghost', 'enriching');
  const ghostId = await legacyAttempt({
    businessId: ghostBusiness, bossJobId: null, key: 'enrich:reconcile-ghost',
  });

  const liveBusiness = await business('reconcile-live', 'enriching');
  const liveKey = 'enrich:reconcile-live';
  const liveBossId = await bossJob('enrich', { businessId: liveBusiness, idempotencyKey: liveKey });
  const liveAttemptId = await legacyAttempt({ businessId: liveBusiness, bossJobId: liveBossId, key: liveKey });

  const duplicateBusiness = await business('reconcile-duplicate', 'enriching');
  const duplicateKey = 'enrich:reconcile-duplicate';
  const canonicalBossId = await bossJob(
    'enrich', { businessId: duplicateBusiness, idempotencyKey: duplicateKey }, 'active',
  );
  const duplicateBossId = await bossJob(
    'enrich', { businessId: duplicateBusiness, idempotencyKey: duplicateKey },
  );
  const canonicalAttemptId = await legacyAttempt({
    businessId: duplicateBusiness, bossJobId: canonicalBossId, key: duplicateKey, status: 'running',
  });
  const duplicateAttemptId = await legacyAttempt({
    businessId: duplicateBusiness, bossJobId: duplicateBossId, key: duplicateKey,
  });

  const incompatibleBusiness = await business('reconcile-incompatible', 'enriching');
  const incompatibleBossId = await bossJob(
    'enrich-socials',
    { businessId: incompatibleBusiness, idempotencyKey: 'enrich:reconcile-incompatible' },
  );
  const incompatibleAttemptId = await legacyAttempt({
    businessId: incompatibleBusiness,
    bossJobId: incompatibleBossId,
    key: 'enrich:reconcile-incompatible',
  });

  const interruptedBusiness = await business('reconcile-interrupted-build', 'site_in_progress');
  const [interruptedProject] = await db.insert(schema.siteProjects).values({
    businessId: interruptedBusiness,
    state: 'building',
    dir: `sites/${interruptedBusiness}`,
  }).returning({ id: schema.siteProjects.id });

  const ambiguousBusiness = await business('reconcile-ambiguous-active', 'enriching');
  const ambiguousKey = 'enrich:reconcile-ambiguous-active';
  const ambiguousBossIds = await Promise.all([
    bossJob('enrich', { businessId: ambiguousBusiness, idempotencyKey: ambiguousKey }, 'active'),
    bossJob('enrich', { businessId: ambiguousBusiness, idempotencyKey: ambiguousKey }, 'active'),
  ]);
  const ambiguousAttemptIds = await Promise.all(ambiguousBossIds.map((bossJobId) => legacyAttempt({
    businessId: ambiguousBusiness,
    bossJobId,
    key: ambiguousKey,
    status: 'running',
  })));

  const first = await reconcileOnStartup(db);

  await check('a single compatible legacy attempt is adopted into one logical run', async () => {
    const [attempt] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, liveAttemptId));
    assert.ok(attempt?.runId);
    assert.equal(attempt.attemptSequence, 1);
    const [run] = await db.select().from(schema.workflowJobRuns)
      .where(eq(schema.workflowJobRuns.id, attempt.runId));
    assert.equal(run?.status, 'queued');
    assert.equal(run?.idempotencyKey, liveKey);
  });

  await check('live duplicates retain one deterministic canonical attempt', async () => {
    const [canonical] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, canonicalAttemptId));
    const [duplicate] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, duplicateAttemptId));
    assert.ok(canonical?.runId);
    assert.equal(canonical.status, 'running');
    assert.equal(duplicate?.status, 'cancelled');
    assert.equal(duplicate?.runId, null);
    const bossState = await pool.query<{ state: string }>(
      'select state::text from pgboss.job where id = $1', [duplicateBossId],
    );
    assert.equal(bossState.rows[0]?.state, 'cancelled');
  });

  await check('every adoption and duplicate closure has a durable audit record', async () => {
    const events = await db.select().from(schema.workflowReconciliationEvents);
    assert.equal(events.filter((event) => event.eventType === 'legacy_run_adopted').length, 2);
    assert.equal(events.filter((event) => event.eventType === 'legacy_duplicate_cancelled').length, 1);
    assert.equal(first.legacy.adoptedRuns, 2);
    assert.equal(first.legacy.cancelledDuplicates, 1);
  });

  await check('an ambiguous legacy queue is parked for explicit operator review', async () => {
    const [attempt] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, incompatibleAttemptId));
    assert.equal(attempt?.status, 'needs_human');
    assert.equal(attempt?.errorCode, 'RECONCILIATION_REQUIRED');
    const [event] = await db.select().from(schema.workflowReconciliationEvents)
      .where(eq(schema.workflowReconciliationEvents.attemptId, incompatibleAttemptId));
    assert.equal(event?.eventType, 'legacy_incompatible_needs_human');
    assert.equal(first.legacy.parkedIncompatible, 3);
  });

  await check('multiple already-active duplicates are parked instead of guessing a winner', async () => {
    const attempts = await db.select().from(schema.workflowJobs)
      .where(inArray(schema.workflowJobs.id, ambiguousAttemptIds));
    assert.equal(attempts.every((attempt) => (
      attempt.status === 'needs_human' && attempt.errorCode === 'RECONCILIATION_REQUIRED'
    )), true);
    assert.equal(attempts.every((attempt) => attempt.runId === null), true);
  });

  await check('a missing pg-boss job is marked stale and its stranded business is recovered', async () => {
    const [attempt] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, ghostId));
    const [recovered] = await db.select().from(schema.businesses)
      .where(eq(schema.businesses.id, ghostBusiness));
    assert.equal(attempt?.status, 'stale');
    assert.equal(recovered?.status, 'needs_review');
    assert.equal(first.staleJobs, 1);
  });

  await check('an interrupted build is made explicitly restartable', async () => {
    const [project] = await db.select().from(schema.siteProjects)
      .where(eq(schema.siteProjects.id, interruptedProject!.id));
    assert.equal(project?.state, 'failed');
    assert.deepEqual(first.interruptedBuilds, [{
      businessId: interruptedBusiness,
      projectId: interruptedProject!.id,
    }]);
  });

  const eventCountBeforeSecond = await db.select().from(schema.workflowReconciliationEvents);
  const second = await reconcileOnStartup(db);
  await check('a second reconciliation pass is a no-op', async () => {
    const events = await db.select().from(schema.workflowReconciliationEvents);
    assert.equal(events.length, eventCountBeforeSecond.length);
    assert.deepEqual(second.legacy, {
      adoptedRuns: 0, cancelledDuplicates: 0, parkedIncompatible: 0,
    });
    assert.equal(second.staleJobs, 0);
    assert.equal(second.revertedBusinesses.length, 0);
  });

  // An old worker claims a duplicate immediately before the repair. The older
  // active attempt wins; the late completion must not undo its cancellation.
  const raceBusiness = await business('reconcile-race', 'enriching');
  const raceKey = 'enrich:reconcile-race';
  const raceCanonicalBossId = await bossJob(
    'enrich', { businessId: raceBusiness, idempotencyKey: raceKey }, 'active',
  );
  await legacyAttempt({ businessId: raceBusiness, bossJobId: raceCanonicalBossId, key: raceKey });
  const raceDuplicateBossId = await bossJob(
    'enrich', { businessId: raceBusiness, idempotencyKey: raceKey },
  );
  const raceDuplicateAttemptId = await legacyAttempt({
    businessId: raceBusiness, bossJobId: raceDuplicateBossId, key: raceKey,
  });

  let releaseHandler!: () => void;
  let handlerStarted!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
  const delivery = processJob(
    'enrich',
    {
      id: raceDuplicateBossId,
      name: 'enrich',
      data: { businessId: raceBusiness, campaignId, idempotencyKey: raceKey },
    } as never,
    async () => {
      handlerStarted();
      await handlerGate;
    },
    boss,
  );
  await started;
  await reconcileOnStartup(db);
  releaseHandler();
  await delivery;

  await check('a stale worker completion cannot overwrite a reconciled duplicate', async () => {
    const [duplicate] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, raceDuplicateAttemptId));
    assert.equal(duplicate?.status, 'cancelled');
    assert.equal(duplicate?.errorCode, 'RECONCILED');
  });

  const adoptedBusiness = await business('reconcile-adopted-in-flight', 'enriching');
  const adoptedKey = 'enrich:reconcile-adopted-in-flight';
  const adoptedBossId = await bossJob(
    'enrich', { businessId: adoptedBusiness, idempotencyKey: adoptedKey },
  );
  const adoptedAttemptId = await legacyAttempt({
    businessId: adoptedBusiness, bossJobId: adoptedBossId, key: adoptedKey,
  });
  let releaseAdopted!: () => void;
  let adoptedStarted!: () => void;
  const adoptedGate = new Promise<void>((resolve) => { releaseAdopted = resolve; });
  const adoptedClaimed = new Promise<void>((resolve) => { adoptedStarted = resolve; });
  const adoptedDelivery = processJob(
    'enrich',
    {
      id: adoptedBossId,
      name: 'enrich',
      data: { businessId: adoptedBusiness, campaignId, idempotencyKey: adoptedKey },
    } as never,
    async () => {
      adoptedStarted();
      await adoptedGate;
    },
    boss,
  );
  await adoptedClaimed;
  await reconcileOnStartup(db);
  releaseAdopted();
  await adoptedDelivery;

  await check('an adopted in-flight legacy attempt closes its logical run on success', async () => {
    const [attempt] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, adoptedAttemptId));
    assert.equal(attempt?.status, 'succeeded');
    assert.ok(attempt?.runId);
    const [run] = await db.select().from(schema.workflowJobRuns)
      .where(eq(schema.workflowJobRuns.id, attempt.runId));
    assert.equal(run?.status, 'succeeded');
    assert.ok(run?.finishedAt);
  });

  const orphanBusiness = await business('reconcile-orphaned-build', 'site_in_progress');
  const orphanRunId = randomUUID();
  const orphanKey = 'build-site:reconcile-orphaned-build';
  const orphanBossId = await bossJob(
    'agent-build',
    {
      __factoryJobName: 'build-site',
      businessId: orphanBusiness,
      idempotencyKey: orphanKey,
      projectId: 1,
    },
    'active',
  );
  await db.insert(schema.workflowJobRuns).values({
    id: orphanRunId,
    jobType: 'build-site',
    idempotencyKey: orphanKey,
    businessId: orphanBusiness,
    campaignId,
    status: 'running',
    currentAttemptSequence: 1,
  });
  await db.insert(schema.workflowJobs).values({
    bossJobId: orphanBossId,
    jobType: 'build-site',
    businessId: orphanBusiness,
    campaignId,
    idempotencyKey: orphanKey,
    runId: orphanRunId,
    attemptSequence: 1,
    payload: { businessId: orphanBusiness, idempotencyKey: orphanKey, projectId: 1 },
    status: 'running',
    attempts: 1,
  });
  const requeued = await requeueOrphanedBuildJobs(['content-and-design', 'build-site'], db);

  await check('build-container recovery resets boss, attempt and logical run together', async () => {
    const [run] = await db.select().from(schema.workflowJobRuns)
      .where(eq(schema.workflowJobRuns.id, orphanRunId));
    const [attempt] = await db.select().from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.runId, orphanRunId));
    const bossState = await pool.query<{ state: string }>(
      'select state::text from pgboss.job where id = $1', [orphanBossId],
    );
    assert.equal(requeued, 1);
    assert.equal(run?.status, 'queued');
    assert.equal(attempt?.status, 'queued');
    assert.equal(bossState.rows[0]?.state, 'retry');
  });

  } finally {
    await runtimeDb.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

console.log(`\n🔧 RECONCILE TESTS PASSED (${passed})`);
