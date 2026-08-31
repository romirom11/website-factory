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
import { OutreachDecisionService } from '../src/orchestrator/outreachDecisionService.js';
import { sendIdempotencyKey } from '../src/outreach/idempotency.js';
import { CampaignCommandService } from '../src/orchestrator/campaignCommandService.js';
import { NormalizationService } from '../src/orchestrator/normalizationService.js';
import type { RawCandidate } from '../src/discovery/candidate.js';
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

  await check('campaign creation and discovery enqueue commit exactly once', async () => {
    const suffix = randomUUID().slice(0, 8);
    const service = new CampaignCommandService(
      store,
      () => 'live',
      () => new Date('2026-08-30T12:00:00.000Z'),
    );
    const input = {
      country: 'GR',
      city: `Πάτρα ${suffix}`,
      niche: 'Beauty',
      language: 'el',
      queries: ['beauty patras'],
      targetCount: 20,
      geofence: { lat: 38.2, lng: 21.7, radiusKm: 10 },
      autoBuild: 'no_site_only' as const,
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => service.create(input)));
    const created = results.filter((result) => result.kind === 'created');
    assert.equal(created.length, 1);
    assert.equal(results.filter((result) => result.kind === 'exists').length, 19);
    const campaignId = results[0]!.campaignId;
    assert.match(campaignId, /πάτρα/);
    assert.equal(await count(
      `select count(*) from campaigns where id = $1 and status = 'running' and mode = 'live'`,
      [campaignId],
    ), 1);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = 'discover' and idempotency_key = $1`,
      [`discover:${campaignId}`],
    ), 1);
  });

  await check('candidate normalization, evidence, and qualification commit exactly once', async () => {
    const suffix = randomUUID();
    const campaignId = `campaign-normalize-${suffix}`;
    await testDb.insert(schema.campaigns).values({
      id: campaignId,
      country: 'GR',
      city: 'Patras',
      niche: 'test',
      language: 'el',
      queries: ['test'],
      geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
    });
    const candidate: RawCandidate = {
      name: `Atomic Salon ${suffix}`,
      category: 'beauty salon',
      address: 'Test street',
      phone: '+30 2610 123456',
      email: `owner-${suffix}@example.test`,
      websiteUrl: null,
      listingUrl: `https://maps.example.test/${suffix}`,
      placeId: `place-${suffix}`,
      rating: 4.8,
      reviewCount: 30,
      lat: 38.2,
      lng: 21.7,
      rawObjectKey: `raw/${suffix}`,
      query: 'beauty patras',
    };
    const service = new NormalizationService(store);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.normalize(campaignId, candidate)),
    );
    assert.equal(results.filter((result) => result.kind === 'created').length, 1);
    assert.equal(results.filter((result) => result.kind === 'duplicate').length, 19);
    const businessId = results[0]!.businessId;
    assert.equal(new Set(results.map((result) => result.businessId)).size, 1);
    assert.equal(await count(`select count(*) from businesses where id = $1`, [businessId]), 1);
    assert.equal(await count(`select count(*) from business_sources where business_id = $1`, [businessId]), 1);
    assert.equal(await count(`select count(*) from business_contacts where business_id = $1`, [businessId]), 2);
    assert.equal(await count(`select count(*) from status_history where business_id = $1`, [businessId]), 1);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where business_id = $1 and job_type = 'fast-qualify'`,
      [businessId],
    ), 1);
  });

  await check('qualification enqueue failure leaves no partial normalized business', async () => {
    const suffix = randomUUID();
    const campaignId = `campaign-normalize-rollback-${suffix}`;
    await testDb.insert(schema.campaigns).values({
      id: campaignId,
      country: 'GR',
      city: 'Patras',
      niche: 'test',
      language: 'el',
      queries: ['test'],
      geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
    });
    const candidate: RawCandidate = {
      name: `Rollback Salon ${suffix}`,
      category: 'beauty salon',
      address: null,
      phone: null,
      email: null,
      websiteUrl: null,
      listingUrl: `https://maps.example.test/rollback/${suffix}`,
      placeId: `rollback-place-${suffix}`,
      rating: null,
      reviewCount: null,
      lat: 38.2,
      lng: 21.7,
      rawObjectKey: `raw/rollback/${suffix}`,
      query: 'beauty patras',
    };
    const failingStore = new WorkflowRunStore(pool, {
      send: async () => { throw new Error('normalize qualification injection'); },
    });
    await assert.rejects(
      new NormalizationService(failingStore).normalize(campaignId, candidate),
      /normalize qualification injection/,
    );
    assert.equal(await count(`select count(*) from businesses where place_id = $1`, [candidate.placeId]), 0);
    assert.equal(await count(`select count(*) from business_sources where raw_object_key = $1`, [candidate.rawObjectKey]), 0);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where idempotency_key like $1`,
      [`fast-qualify:%rollback-salon%`],
    ), 0);
  });

  await check('approval, status transition, and send job commit exactly once', async () => {
    const suffix = randomUUID();
    const campaignId = `campaign-${suffix}`;
    const businessId = `e2e-approval-${suffix}`;
    await testDb.insert(schema.campaigns).values({
      id: campaignId,
      country: 'GR',
      city: 'Patras',
      niche: 'test',
      language: 'el',
      queries: ['test'],
      geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
    });
    await testDb.insert(schema.businesses).values({
      id: businessId,
      campaignId,
      name: 'Approval Test',
      normalizedName: 'approval test',
      status: 'site_ready',
    });
    const [approval] = await testDb.insert(schema.approvals).values({
      businessId,
      kind: 'outreach',
      payload: { proposed: true },
    }).returning({ id: schema.approvals.id });
    const service = new OutreachDecisionService(store, testDb, () => [3, 7]);
    const decisions = await Promise.all(Array.from({ length: 20 }, () => service.approve({
      approvalId: approval!.id,
      channel: 'instagram',
      toAddress: '@approval-test',
      subject: null,
      body: 'Approved body',
    })));

    assert.equal(decisions.filter((result) => result.kind === 'approved').length, 1);
    assert.equal(decisions.filter((result) => result.kind === 'already_decided').length, 19);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where job_type = 'send-outreach' and idempotency_key = $1`,
      [sendIdempotencyKey(approval!.id)],
    ), 1);
    assert.equal(await count(
      `select count(*) from approvals where id = $1 and decision = 'approved'`,
      [approval!.id],
    ), 1);
    assert.equal(await count(
      `select count(*) from businesses where id = $1 and status = 'outreach_approved'`,
      [businessId],
    ), 1);
    assert.equal(await count(
      `select count(*) from status_history where business_id = $1 and from_status = 'site_ready' and to_status = 'outreach_approved'`,
      [businessId],
    ), 1);

    await testDb.insert(schema.outreachMessages).values({
      businessId,
      channel: 'instagram',
      toAddress: '@approval-test',
      body: 'Approved body',
      idempotencyKey: sendIdempotencyKey(approval!.id),
      state: 'manual_pending',
    });
    const confirmations = await Promise.all(
      Array.from({ length: 20 }, () => service.confirmManualSend(approval!.id)),
    );
    assert.equal(confirmations.filter((result) => result.kind === 'confirmed').length, 1);
    assert.equal(confirmations.filter((result) => result.kind === 'already_confirmed').length, 19);
    assert.equal(await count(
      `select count(*) from outreach_events where business_id = $1 and event = 'sent'`,
      [businessId],
    ), 1);
    assert.equal(await count(
      `select count(*) from workflow_job_runs where business_id = $1 and job_type = 'send-followup'`,
      [businessId],
    ), 2);
    assert.equal(await count(
      `select count(*) from businesses where id = $1 and status = 'contacted'`,
      [businessId],
    ), 1);
    assert.equal(await count(`select count(*) from deals where business_id = $1`, [businessId]), 1);
  });

  await check('a send enqueue failure rolls back the approval decision and status', async () => {
    const suffix = randomUUID();
    const campaignId = `campaign-${suffix}`;
    const businessId = `e2e-approval-rollback-${suffix}`;
    await testDb.insert(schema.campaigns).values({
      id: campaignId,
      country: 'GR',
      city: 'Patras',
      niche: 'test',
      language: 'el',
      queries: ['test'],
      geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
    });
    await testDb.insert(schema.businesses).values({
      id: businessId,
      campaignId,
      name: 'Approval Rollback Test',
      normalizedName: 'approval rollback test',
      status: 'site_ready',
    });
    const [approval] = await testDb.insert(schema.approvals).values({ businessId, kind: 'outreach' })
      .returning({ id: schema.approvals.id });
    const failingStore = new WorkflowRunStore(pool, {
      send: async () => { throw new Error('approval send injection'); },
    });
    const service = new OutreachDecisionService(failingStore, testDb, () => [3, 7]);
    await assert.rejects(service.approve({
      approvalId: approval!.id,
      channel: 'email',
      toAddress: 'owner@example.test',
      subject: 'Demo',
      body: 'Approved body',
    }), /approval send injection/);
    assert.equal(await count(
      `select count(*) from approvals where id = $1 and decision is null`,
      [approval!.id],
    ), 1);
    assert.equal(await count(
      `select count(*) from businesses where id = $1 and status = 'site_ready'`,
      [businessId],
    ), 1);
    assert.equal(await count(
      `select count(*) from status_history where business_id = $1`,
      [businessId],
    ), 0);
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
