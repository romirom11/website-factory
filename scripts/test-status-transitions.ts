import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import {
  BusinessTransitionService,
  IllegalBusinessTransitionError,
} from '../src/orchestrator/statuses.js';
import * as schema from '../src/db/schema.js';
import { withDisposableFactoryDatabase } from './lib/disposableFactoryDatabase.js';

let passed = 0;

async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed++;
  console.log(`✅ ${label}`);
}

await withDisposableFactoryDatabase(async ({ db }) => {
  const transitions = new BusinessTransitionService(db);
  const campaignId = 'status-transition-test';
  await db.insert(schema.campaigns).values({
    id: campaignId,
    country: 'GR',
    city: 'Patras',
    niche: 'test',
    language: 'el',
    queries: ['test'],
    geofence: { lat: 38.2466, lng: 21.7346, radiusKm: 1 },
  });

  async function business(id: string, status: string): Promise<void> {
    await db.insert(schema.businesses).values({
      id,
      campaignId,
      name: id,
      normalizedName: id,
      status,
    });
  }

  async function history(id: string) {
    return db.select().from(schema.statusHistory)
      .where(eq(schema.statusHistory.businessId, id));
  }

  await check('two legal workers racing from one state produce one winner and one history row', async () => {
    const id = 'race-two-workers';
    await business(id, 'discovered');

    const results = await Promise.all([
      transitions.normal({
        businessId: id,
        expectedStatus: 'discovered',
        to: 'prequalified',
        actor: 'fast-qualify-a',
        reason: 'passed',
      }),
      transitions.normal({
        businessId: id,
        expectedStatus: 'discovered',
        to: 'needs_review',
        actor: 'fast-qualify-b',
        reason: 'uncertain',
      }),
    ]);

    assert.equal(results.filter((result) => result.kind === 'moved').length, 1);
    assert.equal(results.filter((result) => result.kind === 'conflict').length, 1);
    assert.equal((await history(id)).length, 1);
  });

  await check('a stale retry that targets the committed state is idempotent', async () => {
    const id = 'already-at-target';
    await business(id, 'discovered');
    const first = await transitions.normal({
      businessId: id,
      expectedStatus: 'discovered',
      to: 'prequalified',
      actor: 'fast-qualify',
    });
    const retry = await transitions.normal({
      businessId: id,
      expectedStatus: 'discovered',
      to: 'prequalified',
      actor: 'fast-qualify',
    });

    assert.equal(first.kind, 'moved');
    assert.deepEqual(retry, { kind: 'already_at_target', status: 'prequalified' });
    assert.equal((await history(id)).length, 1);
  });

  await check('an illegal normal edge is rejected without touching state or history', async () => {
    const id = 'illegal-edge';
    await business(id, 'discovered');

    await assert.rejects(
      transitions.normal({
        businessId: id,
        expectedStatus: 'discovered',
        to: 'won',
        actor: 'bad-worker',
      }),
      IllegalBusinessTransitionError,
    );
    const [row] = await db.select({ status: schema.businesses.status })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, id));
    assert.equal(row?.status, 'discovered');
    assert.equal((await history(id)).length, 0);
  });

  await check('a reasoned operator override is explicit and audited', async () => {
    const id = 'operator-override';
    await business(id, 'prequalified');
    const result = await transitions.override({
      businessId: id,
      expectedStatus: 'prequalified',
      to: 'won',
      actor: 'roman',
      reason: 'deal confirmed outside the pipeline',
    });

    assert.equal(result.kind, 'moved');
    const [audit] = await history(id);
    assert.equal(audit?.actor, 'roman');
    assert.equal(audit?.reason, 'deal confirmed outside the pipeline');
  });

  await check('worker and operator race cannot both commit', async () => {
    const id = 'worker-operator-race';
    await business(id, 'enriching');
    const results = await Promise.all([
      transitions.normal({
        businessId: id,
        expectedStatus: 'enriching',
        to: 'qualified',
        actor: 'score-worker',
      }),
      transitions.override({
        businessId: id,
        expectedStatus: 'enriching',
        to: 'rejected',
        actor: 'roman',
        reason: 'owner reviewed the lead',
      }),
    ]);

    assert.equal(results.filter((result) => result.kind === 'moved').length, 1);
    assert.equal(results.filter((result) => result.kind === 'conflict').length, 1);
    assert.equal((await history(id)).length, 1);
  });

  await check('recovery is named, reasoned, and loses to a concurrent forward move', async () => {
    const id = 'recovery-race';
    await business(id, 'site_in_progress');
    const results = await Promise.all([
      transitions.normal({
        businessId: id,
        expectedStatus: 'site_in_progress',
        to: 'site_ready',
        actor: 'deploy-worker',
      }),
      transitions.recover({
        businessId: id,
        expectedStatus: 'site_in_progress',
        to: 'production_ready',
        actor: 'reconciler',
        reason: 'no live build remains',
      }),
    ]);

    assert.equal(results.filter((result) => result.kind === 'moved').length, 1);
    assert.equal(results.filter((result) => result.kind === 'conflict').length, 1);
    assert.equal((await history(id)).length, 1);
  });

  await check('history rows exactly match committed status changes', async () => {
    const ids = ['race-two-workers', 'already-at-target', 'illegal-edge', 'operator-override', 'worker-operator-race', 'recovery-race'];
    const rows = await db.select({
      businessId: schema.statusHistory.businessId,
      to: schema.statusHistory.toStatus,
    }).from(schema.statusHistory);
    const relevant = rows.filter((row) => ids.includes(row.businessId));
    assert.equal(relevant.length, 5);
    for (const row of relevant) {
      const [current] = await db.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, row.businessId));
      assert.equal(current?.status, row.to);
    }
  });
});

console.log(`\n🔒 STATUS TRANSITION TESTS PASSED (${passed})`);
