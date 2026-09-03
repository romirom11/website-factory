/** Regression: a failed build has two endings — retry, or stop without reject. */
import {
  createBusiness, createCampaign, createFailedJob, createSiteProject, destroyFixtures,
  FIXTURE_CAMPAIGN,
} from './e2e/fixtures.js';
import { pool } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
import { FIXTURE_PREFIX, sql, sqlOne } from './e2e/harness.js';
import { loadInbox } from '../ui/lib/inbox.js';
import { retryFailedJob } from '../ui/lib/buildFailureDecision.js';
import { stopFailedBuild } from '../src/orchestrator/buildFailureDecision.js';
import { db } from '../src/db/client.js';
import { getBoss } from '../src/orchestrator/queue.js';
import { WorkflowRunStore } from '../src/orchestrator/workflowRunStore.js';
import { OperatorBusinessCommandService } from '../src/orchestrator/operatorBusinessCommandService.js';

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
  check('operator-stopped project is marked cancelled', site?.state === 'cancelled', site?.state);

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
  // ── «Побудувати заново»: a fresh start from whatever a dead build left ────
  const operator = new OperatorBusinessCommandService(new WorkflowRunStore(pool, await getBoss()), db);

  // Design gate parked the business in site_in_progress with no project at all
  // — the branch that used to have no working button.
  const gateBiz = await createBusiness({
    id: 'e2e-rebuild-gate', name: 'E2E Rebuild Gate', status: 'site_in_progress',
  });
  const gateJobId = await createFailedJob(gateBiz, 'content-and-design');
  await sql(`update workflow_jobs set status = 'needs_human' where id = $1`, [gateJobId]);
  const gateStart = await operator.startBuild(gateBiz.id, { fresh: true });
  check('fresh rebuild starts from a design-gate park', gateStart.kind === 'started', gateStart);
  const gateBusiness = await sqlOne<{ status: string }>(`select status from businesses where id = $1`, [gateBiz.id]);
  const gateJob = await sqlOne<{ status: string; error_detail: string }>(
    `select status, error_detail from workflow_jobs where id = $1`, [gateJobId]);
  const gateQueued = await sqlOne<{ n: string }>(
    `select count(*) as n from workflow_jobs where business_id = $1 and job_type = 'content-and-design' and status = 'queued'`,
    [gateBiz.id]);
  check('fresh rebuild recovers the business to ready-to-build', gateBusiness?.status === 'production_ready', gateBusiness?.status);
  check('fresh rebuild closes the parked step', gateJob?.status === 'cancelled', gateJob);
  check('fresh rebuild queues a new design step', Number(gateQueued?.n) === 1, gateQueued);
  const gateInbox = await loadInbox();
  check('parked step leaves the Inbox after a fresh rebuild', !gateInbox.jobs.some((j) => j.jobId === gateJobId));

  // A failed project next to a failed build step: both are closed together.
  const deadBiz = await createBusiness({
    id: 'e2e-rebuild-dead', name: 'E2E Rebuild Dead', status: 'production_ready',
  });
  const deadProject = await createSiteProject(deadBiz, 'failed');
  const deadJobId = await createFailedJob(deadBiz, 'build-site');
  await sql(`update workflow_jobs set payload = $1::jsonb where id = $2`, [
    JSON.stringify({ businessId: deadBiz.id, projectId: deadProject.projectId, iteration: 2 }), deadJobId,
  ]);
  const deadStart = await operator.startBuild(deadBiz.id, { fresh: true });
  check('fresh rebuild starts next to a failed project', deadStart.kind === 'started', deadStart);
  const deadJob = await sqlOne<{ status: string }>(`select status from workflow_jobs where id = $1`, [deadJobId]);
  check('fresh rebuild closes the failed step', deadJob?.status === 'cancelled', deadJob?.status);

  // A build that is genuinely running is never torn down from here.
  const liveBiz = await createBusiness({
    id: 'e2e-rebuild-live', name: 'E2E Rebuild Live', status: 'site_in_progress',
  });
  const liveProject = await createSiteProject(liveBiz, 'building');
  await sql(
    `insert into workflow_job_runs
       (id, job_type, business_id, campaign_id, idempotency_key, status, current_attempt_sequence, created_at, updated_at)
     values ($1, 'build-site', $2, $3, $4, 'running', 1, now(), now())`,
    [randomUUID(), liveBiz.id, FIXTURE_CAMPAIGN, `${FIXTURE_PREFIX}live:${liveBiz.id}`],
  );
  const liveStart = await operator.startBuild(liveBiz.id, { fresh: true });
  check('fresh rebuild refuses while a build is still running', liveStart.kind === 'state_conflict', liveStart);
  const liveSite = await sqlOne<{ state: string }>(`select state from site_projects where id = $1`, [liveProject.projectId]);
  check('a refused rebuild leaves the live project alone', liveSite?.state === 'building', liveSite?.state);

  // ── «Не будувати» on a failed publish: the built project is closed too ────
  const pubBiz = await createBusiness({
    id: 'e2e-stop-publish', name: 'E2E Stop Publish', status: 'site_in_progress',
  });
  const pubProject = await createSiteProject(pubBiz, 'ready');
  const pubJobId = await createFailedJob(pubBiz, 'deploy-demo');
  await sql(`update workflow_jobs set payload = $1::jsonb where id = $2`, [
    JSON.stringify({ businessId: pubBiz.id, projectId: pubProject.projectId }), pubJobId,
  ]);
  const pubStop = await stopFailedBuild(pubJobId);
  check('stop accepts a failed publish', pubStop.ok, pubStop.message);
  const pubSite = await sqlOne<{ state: string }>(`select state from site_projects where id = $1`, [pubProject.projectId]);
  const pubBusiness = await sqlOne<{ status: string }>(`select status from businesses where id = $1`, [pubBiz.id]);
  check('stopped publish closes the ready project', pubSite?.state === 'cancelled', pubSite?.state);
  check('stopped publish returns the business to ready-to-build', pubBusiness?.status === 'production_ready', pubBusiness?.status);
} finally {
  await destroyFixtures();
  await pool.end();
}

console.log(failures === 0 ? '\n🧪 BUILD FAILURE DECISION TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
