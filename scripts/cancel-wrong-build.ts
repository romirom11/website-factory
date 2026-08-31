/**
 * Cancel a demo build that the factory should never have started.
 *
 * Why (Roman, 2026-08-20): TRENDY HAIR A&A audited as `broken` because the old
 * audit screenshotted a JS-heavy WordPress shop before it painted. `broken`
 * counts as "no site" for the build policy, so the router queued a demo build
 * for a business that already has a working site. The audit is fixed
 * (`src/workers/audit.ts`); this undoes what the wrong verdict caused.
 *
 * Cancellation is done in the order that cannot leave a half-cancelled build:
 * the QUEUE first (so no worker can pick the job up while we are editing rows),
 * then `workflow_jobs`, then `site_projects`, then the business status. Every
 * status change is written to `status_history` with the actor it belongs to.
 *
 *   pnpm tsx scripts/cancel-wrong-build.ts <businessId>            # dry run
 *   pnpm tsx scripts/cancel-wrong-build.ts <businessId> --apply
 */
import 'dotenv/config';
import { eq, and, inArray } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/client.js';
import { getBoss } from '../src/orchestrator/queue.js';
import {
  businessTransitions,
  requireBusinessStatus,
} from '../src/orchestrator/statuses.js';

const businessId = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!businessId || businessId.startsWith('--')) {
  console.error('usage: pnpm tsx scripts/cancel-wrong-build.ts <businessId> [--apply]');
  process.exit(1);
}

/**
 * Written to `businesses.status_reason` and `status_history.reason`, both of
 * which the console renders verbatim on the card header. The console is
 * Ukrainian, so the reason is too — an English string here surfaced raw to
 * Roman (audit 2026-08-20, P1-14).
 */
const REASON = 'сайт насправді працює; помилковий вердикт аудиту';
/** Job states a build can still be picked up from. */
const LIVE_JOB_STATUSES = ['queued', 'running', 'retry_wait'];
/** site_projects states that mean a build is in flight. */
const LIVE_PROJECT_STATES = ['pending', 'brief', 'building', 'qa'];

const [biz] = await db.select().from(schema.businesses)
  .where(eq(schema.businesses.id, businessId));
if (!biz) { console.error(`business not found: ${businessId}`); process.exit(1); }

// ── what is live right now ──────────────────────────────────────────────────
const jobs = await db.select().from(schema.workflowJobs).where(and(
  eq(schema.workflowJobs.businessId, businessId),
  inArray(schema.workflowJobs.status, LIVE_JOB_STATUSES),
));
const buildJobs = jobs.filter((j) => j.jobType === 'build-site' || j.jobType === 'content-and-design');

const projects = await db.select().from(schema.siteProjects).where(and(
  eq(schema.siteProjects.businessId, businessId),
  inArray(schema.siteProjects.state, LIVE_PROJECT_STATES),
));

// pg-boss keeps live jobs in `pgboss.job` and finished ones in `pgboss.archive`.
// Only a live row can still be dequeued, so only that one needs cancelling.
const { rows: bossRows } = await pool.query<{ id: string; name: string; state: string }>(
  `select id, name, state from pgboss.job
    where name in ('build-site','content-and-design')
      and data->>'businessId' = $1
      and state in ('created','retry','active')`,
  [businessId],
);

console.log(`business ${businessId}: status=${biz.status}`);
console.log(`  live pg-boss jobs : ${bossRows.length ? bossRows.map((r) => `${r.name}/${r.state}/${r.id}`).join(', ') : '(none)'}`);
console.log(`  live workflow_jobs: ${buildJobs.length ? buildJobs.map((j) => `#${j.id} ${j.jobType}/${j.status}`).join(', ') : '(none)'}`);
console.log(`  live site_projects: ${projects.length ? projects.map((p) => `#${p.id} ${p.state}`).join(', ') : '(none)'}`);

if (!APPLY) {
  console.log('\ndry run — pass --apply to cancel');
  process.exit(0);
}

// ── 1. the queue, first ─────────────────────────────────────────────────────
// pg-boss `cancel` is what stops a job for good: failing it instead would leave
// retryLimit free to run it again, which is exactly the build we are undoing.
if (bossRows.length) {
  const boss = await getBoss();
  for (const row of bossRows) {
    await boss.cancel(row.name, row.id);
    console.log(`pg-boss cancelled ${row.name}/${row.id}`);
  }
}

// ── 2. our own job ledger ───────────────────────────────────────────────────
for (const job of buildJobs) {
  await db.update(schema.workflowJobs)
    .set({ status: 'cancelled', errorCode: 'CANCELLED', errorDetail: REASON, finishedAt: new Date() })
    .where(eq(schema.workflowJobs.id, job.id));
  console.log(`workflow_jobs #${job.id} -> cancelled`);
}

// ── 3. the project ──────────────────────────────────────────────────────────
// Kept, not deleted: the row records that a build was attempted and why it was
// stopped. Deleting it would erase the only trace of subscription time spent.
for (const project of projects) {
  await db.update(schema.siteProjects)
    .set({ state: 'cancelled', openIssues: [REASON] })
    .where(eq(schema.siteProjects.id, project.id));
  console.log(`site_projects #${project.id} -> cancelled`);
}

// ── 4. the business ─────────────────────────────────────────────────────────
// `site_in_progress -> production_ready` is not a machine transition (the
// machine only ever moves forward from there), so it is recorded as Roman's
// decision, which is what it is.
if (biz.status === 'site_in_progress') {
  const result = await businessTransitions.recover({
    businessId,
    expectedStatus: requireBusinessStatus(biz.status, `business ${businessId}`),
    to: 'production_ready',
    actor: 'roman',
    reason: REASON,
  });
  console.log(result.kind === 'conflict'
    ? `business ${businessId} already moved to ${result.currentStatus}; status not overwritten`
    : `business ${businessId} -> production_ready`);
}

console.log('\ndone');
process.exit(0);
