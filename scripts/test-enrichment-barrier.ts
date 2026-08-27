/** PostgreSQL + pg-boss proof for the enrichment fan-out/join contract. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import {
  EnrichmentBarrier,
  failEnrichmentBranchInTransaction,
} from '../src/orchestrator/enrichmentBarrier.js';
import {
  WorkflowRunStore,
  type BossSender,
} from '../src/orchestrator/workflowRunStore.js';
import { withDisposableFactoryDatabase } from './lib/disposableFactoryDatabase.js';

let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

await withDisposableFactoryDatabase(async ({ connectionString, pool, db, boss }) => {
  const campaignId = `barrier-campaign-${randomUUID()}`;
  await db.insert(schema.campaigns).values({
    id: campaignId,
    country: 'GR',
    city: 'Patras',
    niche: 'test',
    language: 'el',
    queries: ['test'],
    geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
  });

  const createBusiness = async (): Promise<string> => {
    const businessId = `barrier-${randomUUID()}`;
    await db.insert(schema.businesses).values({
      id: businessId,
      campaignId,
      name: 'Barrier proof business',
      normalizedName: businessId,
      status: 'enriching',
    });
    return businessId;
  };

  const count = async (query: string, values: unknown[] = []): Promise<number> => {
    const result = await pool.query<{ count: string }>(query, values);
    return Number(result.rows[0]?.count ?? 0);
  };

  const barrier = new EnrichmentBarrier(new WorkflowRunStore(pool, boss));

  await check('fan-out rolls back the run and both queue schemas when either send fails', async () => {
    for (const failOnSend of [1, 2]) {
      const businessId = await createBusiness();
      let sends = 0;
      const failingBoss: BossSender = {
        send: async (name, data, options) => {
          sends++;
          const result = await boss.send(name, data, options);
          if (sends === failOnSend) throw new Error(`injected send ${failOnSend} failure`);
          return result;
        },
      };
      const failingBarrier = new EnrichmentBarrier(new WorkflowRunStore(pool, failingBoss));
      await assert.rejects(
        failingBarrier.start({ businessId, campaignId }),
        new RegExp(`injected send ${failOnSend} failure`),
      );
      assert.equal(await count('select count(*) from enrichment_runs where business_id = $1', [businessId]), 0);
      assert.equal(await count('select count(*) from workflow_job_runs where business_id = $1', [businessId]), 0);
      assert.equal(await count('select count(*) from workflow_jobs where business_id = $1', [businessId]), 0);
      assert.equal(await count(
        `select count(*) from pgboss.job where data->>'businessId' = $1`,
        [businessId],
      ), 0);
    }
  });

  await check('start creates one generation and both branch jobs atomically', async () => {
    const businessId = await createBusiness();
    const started = await barrier.start({ businessId, campaignId, imageUrls: ['https://example.com/a.jpg'] });
    assert.equal(started.generation, 1);
    assert.equal(started.jobs.length, 2);
    assert.equal(started.jobs.every((job) => job.kind === 'accepted'), true);
    const [run] = await db.select().from(schema.enrichmentRuns)
      .where(eq(schema.enrichmentRuns.id, started.runId));
    assert.equal(run?.status, 'running');
    assert.equal(run?.assetsStatus, 'pending');
    assert.equal(run?.auditStatus, 'pending');
    assert.equal(await barrier.authorizeBranch({
      runId: started.runId,
      businessId,
      branch: 'assets',
    }), 'run');
    const payloads = await db.select({ payload: schema.workflowJobs.payload })
      .from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.businessId, businessId));
    assert.deepEqual(
      new Set(payloads.map((row) => (row.payload as Record<string, unknown>).enrichmentRunId)),
      new Set([started.runId]),
    );
  });

  for (const [label, first, second] of [
    ['assets first', 'assets', 'audit'],
    ['audit first', 'audit', 'assets'],
  ] as const) {
    await check(`${label} waits for the other branch and then enqueues one score`, async () => {
      const businessId = await createBusiness();
      const started = await barrier.start({ businessId, campaignId });
      const firstResult = await barrier.completeBranch({
        runId: started.runId,
        businessId,
        branch: first,
      });
      assert.equal(firstResult.kind, 'recorded');
      assert.equal(await count(
        `select count(*) from workflow_job_runs where job_type = 'score-and-qa' and business_id = $1`,
        [businessId],
      ), 0);
      const secondResult = await barrier.completeBranch({
        runId: started.runId,
        businessId,
        branch: second,
      });
      assert.equal(secondResult.kind, 'score_enqueued');
      assert.equal(await count(
        `select count(*) from workflow_job_runs where job_type = 'score-and-qa' and business_id = $1`,
        [businessId],
      ), 1);
    });
  }

  await check('concurrent completions and retry deliveries still enqueue exactly one score', async () => {
    const businessId = await createBusiness();
    const started = await barrier.start({ businessId, campaignId });
    const results = await Promise.all([
      barrier.completeBranch({ runId: started.runId, businessId, branch: 'assets' }),
      barrier.completeBranch({ runId: started.runId, businessId, branch: 'audit' }),
      barrier.completeBranch({ runId: started.runId, businessId, branch: 'assets' }),
      barrier.completeBranch({ runId: started.runId, businessId, branch: 'audit' }),
    ]);
    assert.equal(results.filter((result) => result.kind === 'score_enqueued').length, 1);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = 'score-and-qa' and business_id = $1`,
      [businessId],
    ), 1);
    assert.equal(await count(
      `select count(*) from pgboss.job where data->>'enrichmentRunId' = $1 and data->>'__factoryJobName' = 'score-and-qa'`,
      [started.runId],
    ), 1);
  });

  await check('contradiction and terminal failure block scoring explicitly', async () => {
    const contradictionBusiness = await createBusiness();
    const contradiction = await barrier.start({ businessId: contradictionBusiness, campaignId });
    const blocked = await barrier.blockBranch({
      runId: contradiction.runId,
      businessId: contradictionBusiness,
      branch: 'audit',
      reason: 'website evidence contradicts owned identity',
    });
    assert.equal(blocked.kind, 'blocked');
    await barrier.completeBranch({
      runId: contradiction.runId,
      businessId: contradictionBusiness,
      branch: 'assets',
    });
    const [contradictionRow] = await db.select().from(schema.enrichmentRuns)
      .where(eq(schema.enrichmentRuns.id, contradiction.runId));
    assert.equal(contradictionRow?.assetsStatus, 'succeeded');
    assert.equal(contradictionRow?.auditStatus, 'blocked');
    assert.equal(await barrier.authorizeBranch({
      runId: contradiction.runId,
      businessId: contradictionBusiness,
      branch: 'audit',
    }), 'settled');

    const failureBusiness = await createBusiness();
    const failure = await barrier.start({ businessId: failureBusiness, campaignId });
    await db.transaction(async (tx) => {
      await failEnrichmentBranchInTransaction(tx, {
        runId: failure.runId,
        businessId: failureBusiness,
        branch: 'assets',
        reason: 'asset retries exhausted',
      });
    });
    await barrier.completeBranch({ runId: failure.runId, businessId: failureBusiness, branch: 'audit' });

    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = 'score-and-qa' and business_id in ($1, $2)`,
      [contradictionBusiness, failureBusiness],
    ), 0);
    const blockedRuns = await db.select().from(schema.enrichmentRuns)
      .where(and(
        eq(schema.enrichmentRuns.status, 'blocked'),
      ));
    assert.equal(blockedRuns.filter((run) => [contradiction.runId, failure.runId].includes(run.id)).length, 2);
  });

  await check('a new generation supersedes the old and ignores its late results', async () => {
    const businessId = await createBusiness();
    const oldRun = await barrier.start({ businessId, campaignId });
    const currentRun = await barrier.start({ businessId, campaignId });
    assert.equal(currentRun.generation, 2);
    let staleBranchMutationRan = false;
    const late = await barrier.completeBranch(
      { runId: oldRun.runId, businessId, branch: 'assets' },
      async () => { staleBranchMutationRan = true; },
    );
    assert.equal(late.kind, 'stale');
    assert.equal(staleBranchMutationRan, false);
    assert.equal(await barrier.authorizeBranch({
      runId: oldRun.runId,
      businessId,
      branch: 'audit',
    }), 'stale');
    await Promise.all([
      barrier.completeBranch({ runId: currentRun.runId, businessId, branch: 'assets' }),
      barrier.completeBranch({ runId: currentRun.runId, businessId, branch: 'audit' }),
    ]);
    const [oldRow] = await db.select().from(schema.enrichmentRuns)
      .where(eq(schema.enrichmentRuns.id, oldRun.runId));
    assert.equal(oldRow?.status, 'superseded');
    let staleScoreMutationRan = false;
    assert.equal(await barrier.commitScore(
      { runId: oldRun.runId, businessId },
      async () => { staleScoreMutationRan = true; },
    ), false);
    assert.equal(staleScoreMutationRan, false);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = 'score-and-qa' and business_id = $1`,
      [businessId],
    ), 1);
  });

  await check('pre-migration branch deliveries share a legacy run but never join native work', async () => {
    const legacyBusiness = await createBusiness();
    const first = await barrier.adoptLegacyBranch(legacyBusiness);
    const second = await barrier.adoptLegacyBranch(legacyBusiness);
    assert.equal(first.kind, 'adopted');
    assert.equal(second.kind, 'adopted');
    assert.equal(second.runId, first.runId);
    await Promise.all([
      barrier.completeBranch({ runId: first.runId, businessId: legacyBusiness, branch: 'assets' }),
      barrier.completeBranch({ runId: first.runId, businessId: legacyBusiness, branch: 'audit' }),
    ]);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = 'score-and-qa' and business_id = $1`,
      [legacyBusiness],
    ), 1);

    const nativeBusiness = await createBusiness();
    const native = await barrier.start({ businessId: nativeBusiness, campaignId });
    const conflict = await barrier.adoptLegacyBranch(nativeBusiness);
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.runId, native.runId);
  });

  await check('score authorization requires the current complete generation', async () => {
    const businessId = await createBusiness();
    const started = await barrier.start({ businessId, campaignId });
    assert.equal(await barrier.isScoreCurrent({ runId: started.runId, businessId }), false);
    await barrier.completeBranch({ runId: started.runId, businessId, branch: 'assets' });
    await barrier.completeBranch({ runId: started.runId, businessId, branch: 'audit' });
    assert.equal(await barrier.isScoreCurrent({ runId: started.runId, businessId }), true);
    await assert.rejects(
      barrier.commitScore({ runId: started.runId, businessId }, async (tx) => {
        await tx.insert(schema.productionGaps).values({
          businessId,
          gap: 'score-rollback-proof',
          blockerLevel: 'soft',
        });
        throw new Error('score commit rollback proof');
      }),
      /score commit rollback proof/,
    );
    assert.equal(await count(
      `select count(*) from production_gaps where business_id = $1 and gap = 'score-rollback-proof'`,
      [businessId],
    ), 0);
    assert.equal(await barrier.isScoreCurrent({ runId: started.runId, businessId }), true);
    assert.equal(await barrier.completeScore({ runId: started.runId, businessId }), true);
    assert.equal(await barrier.isScoreCurrent({ runId: started.runId, businessId }), false);
  });

  await check('branch evidence and branch completion share one rollback boundary', async () => {
    const businessId = await createBusiness();
    const started = await barrier.start({ businessId, campaignId });
    await assert.rejects(
      barrier.completeBranch(
        { runId: started.runId, businessId, branch: 'audit' },
        async (tx) => {
          await tx.insert(schema.productionGaps).values({
            businessId,
            gap: 'audit-rollback-proof',
            blockerLevel: 'soft',
          });
          throw new Error('audit branch rollback proof');
        },
      ),
      /audit branch rollback proof/,
    );
    const [run] = await db.select().from(schema.enrichmentRuns)
      .where(eq(schema.enrichmentRuns.id, started.runId));
    assert.equal(run?.auditStatus, 'pending');
    assert.equal(await count(
      `select count(*) from production_gaps where business_id = $1 and gap = 'audit-rollback-proof'`,
      [businessId],
    ), 0);
  });

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;
  const [{ processJob }, runtimeDb] = await Promise.all([
    import('../src/orchestrator/queue.js'),
    import('../src/db/client.js'),
  ]);
  try {
    await check('worker retries leave the branch pending and only terminal failure blocks it', async () => {
      const businessId = await createBusiness();
      const started = await barrier.start({ businessId, campaignId });
      const [attempt] = await db.select().from(schema.workflowJobs)
        .where(and(
          eq(schema.workflowJobs.businessId, businessId),
          eq(schema.workflowJobs.jobType, 'collect-assets'),
        ));
      assert.ok(attempt?.bossJobId);
      const payload = attempt.payload as Record<string, unknown>;
      const delivery = {
        id: attempt.bossJobId,
        name: 'agent-core',
        data: payload,
      } as never;

      for (let invocation = 1; invocation <= 3; invocation++) {
        await assert.rejects(
          processJob('collect-assets', delivery, async () => {
            throw new Error(`transient asset failure ${invocation}`);
          }, boss),
          /transient asset failure/,
        );
        const [run] = await db.select().from(schema.enrichmentRuns)
          .where(eq(schema.enrichmentRuns.id, started.runId));
        assert.equal(run?.status, 'running');
        assert.equal(run?.assetsStatus, 'pending');
      }

      await assert.rejects(
        processJob('collect-assets', delivery, async () => {
          throw new Error('terminal asset failure');
        }, boss),
        /terminal asset failure/,
      );
      const [blocked] = await db.select().from(schema.enrichmentRuns)
        .where(eq(schema.enrichmentRuns.id, started.runId));
      assert.equal(blocked?.status, 'blocked');
      assert.equal(blocked?.assetsStatus, 'failed');
      assert.match(blocked?.blockingReason ?? '', /retries exhausted/);
      const [businessRow] = await db.select().from(schema.businesses)
        .where(eq(schema.businesses.id, businessId));
      assert.equal(businessRow?.status, 'needs_review');
    });
  } finally {
    await runtimeDb.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }

  console.log(`\n🏭 ENRICHMENT BARRIER TESTS PASSED (${passed})`);
});
