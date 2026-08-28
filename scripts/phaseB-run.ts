/**
 * Phase B real run: pushes every prequalified business of a campaign through
 * stages 4-8 and waits for the pipeline to settle.
 *
 * The job flow is the normal one (enrich -> assets+audit -> score-and-qa ->
 * readiness-gate); this script only seeds it and reports. Run `pnpm workers`
 * alongside, or pass --workers to host them in this process.
 *
 * Agent rate limits are expected, not exceptional: a parked job sits in
 * `retry_wait` with `next_attempt_at` set and the poll loop keeps waiting
 * (spec §2.3) rather than declaring failure.
 */
import { eq, and, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../src/db/client.js';
import { enqueue, register } from '../src/orchestrator/queue.js';
import { enrichHandler } from '../src/workers/enrich.js';
import { collectAssetsHandler } from '../src/workers/assets.js';
import { auditHandler } from '../src/workers/audit.js';
import { scoreAndQaHandler } from '../src/workers/score.js';
import { readinessHandler } from '../src/workers/readiness.js';
import { fastQualifyHandler } from '../src/workers/fastQualify.js';
import { ensureBuckets } from '../src/lib/storage.js';

const campaignId = process.argv[2] ?? 'gr-patras-beauty';
const hostWorkers = process.argv.includes('--workers');
/** Terminal for this phase: nothing further will be enqueued automatically. */
const SETTLED = ['production_ready', 'needs_review', 'rejected', 'duplicate', 'closed', 'do_not_contact', 'site_in_progress'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

await ensureBuckets();

/**
 * Release jobs a previously-killed worker left `active`.
 *
 * pg-boss only reassigns an abandoned job when it expires, and agent jobs get a
 * 90-minute expiry (a site build is legitimately long). Agent queues also run
 * through explicit consumer handles. Resetting a stale active row prevents the
 * queue slot from remaining occupied until the 90-minute agent expiry.
 */
const orphans = await db.execute(sql`
  update pgboss.job set state = 'created', started_on = null
   where name in ('enrich', 'collect-assets', 'audit-website', 'score-and-qa', 'readiness-gate')
     and state = 'active'
     and started_on < now() - interval '5 minutes'
  returning id`);
const orphanCount = (orphans as unknown as { rows?: unknown[] }).rows?.length ?? 0;
if (orphanCount) console.log(`released ${orphanCount} orphaned job(s) left active by a dead worker`);

if (hostWorkers) {
  // Only the stage 2-8 handlers. `startWorkers()` registers EVERY job type, so
  // hosting it here would also execute phase C/D work (content-and-design,
  // build-site, outreach) — and those calls compete for the same in-process
  // agent semaphore, starving the enrichment this script exists to drive.
  // Whoever owns those phases hosts them in their own process.
  await register('enrich', enrichHandler);
  await register('collect-assets', collectAssetsHandler);
  await register('audit-website', auditHandler);
  await register('score-and-qa', scoreAndQaHandler);
  await register('readiness-gate', readinessHandler);
  await register('fast-qualify', fastQualifyHandler);
  console.log('stage 2-8 workers hosted in this process (phase C/D jobs are NOT consumed here)');
}

const targets = await db.select({ id: schema.businesses.id })
  .from(schema.businesses)
  .where(and(eq(schema.businesses.campaignId, campaignId), eq(schema.businesses.status, 'prequalified')));

console.log(`enqueuing enrich for ${targets.length} prequalified businesses in ${campaignId}`);
for (const t of targets) {
  await enqueue('enrich', { businessId: t.id, campaignId });
}

const started = Date.now();
let lastLine = '';
for (;;) {
  const statuses = await db.select({ status: schema.businesses.status, n: sql<number>`count(*)::int` })
    .from(schema.businesses).where(eq(schema.businesses.campaignId, campaignId))
    .groupBy(schema.businesses.status);
  const jobs = await db.select({ status: schema.workflowJobs.status, n: sql<number>`count(*)::int` })
    .from(schema.workflowJobs)
    .where(and(
      eq(schema.workflowJobs.campaignId, campaignId),
      inArray(schema.workflowJobs.status, ['queued', 'running', 'retry_wait']),
    ))
    .groupBy(schema.workflowJobs.status);

  const settled = statuses.filter((s) => SETTLED.includes(s.status)).reduce((a, b) => a + b.n, 0);
  const total = statuses.reduce((a, b) => a + b.n, 0);
  const inFlight = jobs.reduce((a, b) => a + b.n, 0);
  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  const line = `[${mins}m] settled ${settled}/${total} | ${statuses.map((s) => `${s.status}=${s.n}`).join(' ')} | jobs ${jobs.map((j) => `${j.status}=${j.n}`).join(' ') || 'idle'}`;
  if (line !== lastLine) { console.log(line); lastLine = line; }

  if (settled >= total && inFlight === 0) {
    console.log(`\nPipeline settled after ${mins} minutes.`);
    break;
  }
  await sleep(15_000);
}

const finalStatuses = await db.select({ status: schema.businesses.status, n: sql<number>`count(*)::int` })
  .from(schema.businesses).where(eq(schema.businesses.campaignId, campaignId))
  .groupBy(schema.businesses.status).orderBy(sql`2 desc`);
console.log('\nfinal status distribution:');
for (const s of finalStatuses) console.log(`  ${s.status.padEnd(18)} ${s.n}`);
process.exit(0);
