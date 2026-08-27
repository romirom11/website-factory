/** Regression: a failed build has two endings — retry, or stop without reject. */
import {
  createBusiness, createCampaign, createFailedJob, createSiteProject, destroyFixtures,
  FIXTURE_CAMPAIGN,
} from './e2e/fixtures.js';
import { pool } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
import { sql, sqlOne } from './e2e/harness.js';
import { loadInbox } from '../ui/lib/inbox.js';
import { retryFailedJob } from '../ui/lib/buildFailureDecision.js';
import { stopFailedBuild } from '../src/orchestrator/buildFailureDecision.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`✅ ${label}`);
  else { failures++; console.error(`❌ ${label}`, detail ?? ''); }
}

await destroyFixtures();
try {
  await createCampaign();
  const biz = await createBusiness({
    id: 'e2e-build-stop', name: 'E2E Build Stop', status: 'site_in_progress',
  });
  const project = await createSiteProject(biz, 'building');
  const jobId = await createFailedJob(biz, 'build-site');
  await sql(`update workflow_jobs set payload = $1::jsonb where id = $2`, [
    JSON.stringify({ businessId: biz.id, projectId: project.projectId, iteration: 1 }),
    jobId,
  ]);

  const before = await loadInbox();
  check('failed build is an inbox decision',
    before.jobs.some((job) => job.jobId === jobId));

  const result = await stopFailedBuild(jobId);
  check('stop action succeeds', result.ok, result.message);

  const job = await sqlOne<{ status: string }>(
    `select status from workflow_jobs where id = $1`, [jobId]);
  const business = await sqlOne<{ status: string }>(
    `select status from businesses where id = $1`, [biz.id]);
  const site = await sqlOne<{ state: string }>(
    `select state from site_projects where id = $1`, [project.projectId]);
  check('failed attempt is closed', job?.status === 'cancelled', job?.status);
  check('business returns to ready-to-build, not rejected',
    business?.status === 'production_ready', business?.status);
  check('abandoned project is marked failed', site?.state === 'failed', site?.state);

  const after = await loadInbox();
  check('stopped build leaves Inbox', !after.jobs.some((item) => item.jobId === jobId));

  const raceBiz = await createBusiness({
    id: 'e2e-build-race', name: 'E2E Build Race', status: 'site_in_progress',
  });
  const raceProject = await createSiteProject(raceBiz, 'building');
  const raceJobId = await createFailedJob(raceBiz, 'build-site');
  const raceRunId = randomUUID();
  await sql(
    `insert into workflow_job_runs
       (id, job_type, idempotency_key, business_id, campaign_id, status, current_attempt_sequence, finished_at)
     values ($1, 'build-site', $2, $3, $4, 'failed', 1, now())`,
    [raceRunId, `e2e-job:${raceBiz.id}:linked`, raceBiz.id, FIXTURE_CAMPAIGN],
  );
  await sql(
    `update workflow_jobs set run_id = $1, attempt_sequence = 1 where id = $2`,
    [raceRunId, raceJobId],
  );
  await sql(`update workflow_jobs set payload = $1::jsonb where id = $2`, [
    JSON.stringify({ businessId: raceBiz.id, projectId: raceProject.projectId, iteration: 2 }),
    raceJobId,
  ]);

  let releaseEnqueue!: () => void;
  let retryClaimed!: () => void;
  const enqueueGate = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
  const claimSeen = new Promise<void>((resolve) => { retryClaimed = resolve; });
  const retry = retryFailedJob(raceJobId, async () => {
    retryClaimed();
    await enqueueGate;
    return {
      kind: 'accepted' as const,
      runId: 'fake-run',
      runStatus: 'queued' as const,
      attemptId: 1,
      attemptSequence: 1,
      bossJobId: 'fake-successor',
    };
  });
  await claimSeen;
  const losingStop = await stopFailedBuild(raceJobId);
  check('Stop cannot override a retry that already claimed the failed attempt', !losingStop.ok);
  releaseEnqueue();
  check('the winning retry completes', await retry === 'queued');
  const linkedRun = await sqlOne<{ status: string }>(
    `select status from workflow_job_runs where id = $1`, [raceRunId]);
  check('retry closes the previous logical run with its attempt', linkedRun?.status === 'cancelled');

  const raceBusiness = await sqlOne<{ status: string }>(
    `select status from businesses where id = $1`, [raceBiz.id]);
  const raceSite = await sqlOne<{ state: string }>(
    `select state from site_projects where id = $1`, [raceProject.projectId]);
  check('losing Stop does not rewind business state', raceBusiness?.status === 'site_in_progress');
  check('losing Stop does not fail the active project', raceSite?.state === 'building');

  const ownerBiz = await createBusiness({
    id: 'e2e-build-owner', name: 'E2E Build Owner', status: 'site_in_progress',
  });
  const otherBiz = await createBusiness({
    id: 'e2e-build-other', name: 'E2E Build Other', status: 'site_in_progress',
  });
  const otherProject = await createSiteProject(otherBiz, 'building');
  const ownerJobId = await createFailedJob(ownerBiz, 'build-site');
  await sql(`update workflow_jobs set payload = $1::jsonb where id = $2`, [
    JSON.stringify({ businessId: ownerBiz.id, projectId: otherProject.projectId }),
    ownerJobId,
  ]);
  const ownerStop = await stopFailedBuild(ownerJobId);
  check('a malformed project reference does not block closing the failed attempt', ownerStop.ok);
  const untouchedOther = await sqlOne<{ state: string }>(
    `select state from site_projects where id = $1`, [otherProject.projectId]);
  check('Stop never mutates another business project', untouchedOther?.state === 'building');
} finally {
  await destroyFixtures();
  await pool.end();
}

console.log(failures === 0 ? '\n🧪 BUILD FAILURE DECISION TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
