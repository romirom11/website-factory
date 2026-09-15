import assert from 'node:assert/strict';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import {
  claimBuildReviewDecision,
  parkBuildForHumanReview,
  reviewSuccessorJob,
} from '../src/orchestrator/buildReviewDecision.js';
import { withDisposableFactoryDatabase } from './lib/disposableFactoryDatabase.js';

let passed = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed++;
  console.log(`✅ ${label}`);
}

await withDisposableFactoryDatabase(async ({ db }) => {
  const campaignId = 'build-review-decisions';
  await db.insert(schema.campaigns).values({
    id: campaignId,
    country: 'GR',
    city: 'Patras',
    niche: 'test',
    language: 'el',
    queries: ['test'],
    geofence: { lat: 38.2, lng: 21.7, radiusKm: 1 },
  });

  async function fixture(id: string) {
    await db.insert(schema.businesses).values({
      id,
      campaignId,
      name: id,
      normalizedName: id,
      status: 'site_in_progress',
    });
    const [project] = await db.insert(schema.siteProjects).values({
      businessId: id,
      dir: `/tmp/${id}`,
      state: 'qa',
    }).returning({ id: schema.siteProjects.id });
    return project!.id;
  }

  await check('visual QA parks project and business atomically', async () => {
    const businessId = 'park-atomically';
    const projectId = await fixture(businessId);
    assert.equal(await parkBuildForHumanReview({
      projectId,
      businessId,
      reason: 'QA cap reached',
    }, db), true);

    const [[business], [project]] = await Promise.all([
      db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId)),
      db.select().from(schema.siteProjects).where(eq(schema.siteProjects.id, projectId)),
    ]);
    assert.equal(business?.status, 'needs_review');
    assert.equal(project?.state, 'needs_human_review');
  });

  await check('deploy as-is creates a legal deploy pair and one audit move', async () => {
    const businessId = 'deploy-as-is';
    const projectId = await fixture(businessId);
    await parkBuildForHumanReview({ projectId, businessId, reason: 'QA cap reached' }, db);
    const result = await claimBuildReviewDecision({
      projectId,
      decision: 'deploy_as_is',
      reason: 'Roman accepted the reviewed build',
    }, db);
    assert.equal(result.kind, 'claimed');

    const [[business], [project], history] = await Promise.all([
      db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId)),
      db.select().from(schema.siteProjects).where(eq(schema.siteProjects.id, projectId)),
      db.select().from(schema.statusHistory)
        .where(eq(schema.statusHistory.businessId, businessId))
        .orderBy(asc(schema.statusHistory.id)),
    ]);
    assert.equal(business?.status, 'site_in_progress');
    assert.equal(project?.state, 'ready');
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((row) => row.toStatus), ['needs_review', 'site_in_progress']);
  });

  await check('another iteration is a fix round that keeps the QA counter and hands it to its job', async () => {
    const businessId = 'another-iteration';
    const projectId = await fixture(businessId);
    await db.update(schema.siteProjects).set({ qaIterations: 3 })
      .where(eq(schema.siteProjects.id, projectId));
    await parkBuildForHumanReview({ projectId, businessId, reason: 'QA cap reached' }, db);
    const input = {
      projectId, decision: 'another_iteration' as const, reason: 'fix the hero', instruction: 'hero shakes',
    };
    const result = await claimBuildReviewDecision(input, db);
    assert.equal(result.kind, 'claimed');
    const [project] = await db.select().from(schema.siteProjects)
      .where(eq(schema.siteProjects.id, projectId));
    assert.equal(project?.state, 'building');
    assert.equal(project?.qaIterations, 3, 'the counter is not reset: one round, then back to Roman');
    const job = reviewSuccessorJob(input, businessId, project?.qaIterations ?? 0);
    assert.equal(job.name, 'build-site');
    // visual-qa applies its verdict only when the two agree (2026-09-05 regression),
    // and the builder treats 0 as a fresh build that ignores the note (2026-09-15).
    assert.equal(job.data.iteration, project?.qaIterations);
    assert.ok((job.data.iteration ?? 0) > 0);
    assert.deepEqual(job.data.issues, ['[high/roman] hero shakes']);
    assert.equal(reviewSuccessorJob({ ...input, decision: 'deploy_as_is' }, businessId, 3).name, 'deploy-demo');
  });

  await check('concurrent operator buttons have exactly one consistent winner', async () => {
    const businessId = 'decision-race';
    const projectId = await fixture(businessId);
    await parkBuildForHumanReview({ projectId, businessId, reason: 'QA cap reached' }, db);

    const results = await Promise.all([
      claimBuildReviewDecision({
        projectId, decision: 'deploy_as_is', reason: 'ship',
      }, db),
      claimBuildReviewDecision({
        projectId, decision: 'another_iteration', reason: 'fix spacing',
      }, db),
      claimBuildReviewDecision({
        projectId, decision: 'reject', reason: 'not worth more work',
      }, db),
    ]);
    assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
    assert.equal(results.filter((result) => result.kind === 'conflict').length, 2);

    const [[business], [project], history] = await Promise.all([
      db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId)),
      db.select().from(schema.siteProjects).where(eq(schema.siteProjects.id, projectId)),
      db.select().from(schema.statusHistory)
        .where(eq(schema.statusHistory.businessId, businessId)),
    ]);
    const legalPairs = new Set([
      'site_in_progress:ready',
      'site_in_progress:building',
      'rejected:failed',
    ]);
    assert.equal(legalPairs.has(`${business?.status}:${project?.state}`), true);
    assert.equal(history.length, 2);
  });
});

console.log(`\n🎛️ BUILD REVIEW DECISION TESTS PASSED (${passed})`);
