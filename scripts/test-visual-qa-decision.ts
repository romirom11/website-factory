/**
 * Regression for a resolved visual-QA verdict whose job journal stayed open.
 *
 * The QA worker's final verdict is a human decision, never a retryable crash.
 * While the project waits in `needs_human_review`, Inbox must surface the rich
 * build-review card. Once a human decision advances that project, the old
 * `needs_human` job is history and must not resurrect as generic «Повторити».
 */
import { pool } from '../src/db/client.js';
import { loadInbox } from '../ui/lib/inbox.js';
import { claimBuildReviewDecision } from '../src/orchestrator/buildReviewDecision.js';

const suffix = `${Date.now()}-${process.pid}`;
const campaignId = `e2e-vqa-decision-${suffix}`;
const businessId = `e2e-vqa-decision-business-${suffix}`;
let projectId: number | null = null;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  console.log(`✅ ${label}`);
}

try {
  await pool.query(
    `insert into campaigns (id, country, city, niche, language, queries, geofence, mode, status)
     values ($1, 'gr', 'E2E Town', 'beauty', 'el', '[]'::jsonb,
       '{"lat":38,"lng":21,"radiusKm":5}'::jsonb, 'dry_run', 'created')`,
    [campaignId],
  );
  await pool.query(
    `insert into businesses (id, campaign_id, name, normalized_name, status, status_reason)
     values ($1, $2, 'E2E QA Decision Salon', 'e2e qa decision salon', 'needs_review',
       'QA limit reached with 18 open issues')`,
    [businessId, campaignId],
  );
  const project = await pool.query<{ id: number }>(
    `insert into site_projects (business_id, dir, state, qa_iterations, build_ok, open_issues)
     values ($1, '/tmp/e2e-vqa-decision', 'needs_human_review', 3, true,
       '["[high] first remaining issue", "[medium] second remaining issue"]'::jsonb)
     returning id`,
    [businessId],
  );
  projectId = project.rows[0]!.id;
  await pool.query(
    `insert into workflow_jobs
       (job_type, business_id, campaign_id, idempotency_key, payload, status,
        attempts, error_code, error_detail, created_at, finished_at)
     values ('visual-qa', $1, $2, $3, $4::jsonb, 'needs_human', 1,
       'NEEDS_HUMAN', 'visual QA exhausted 3 iterations; 18 issues remain', now(), now())`,
    [businessId, campaignId, `e2e-vqa-decision:${suffix}`, JSON.stringify({ projectId })],
  );

  const inbox = await loadInbox();
  const review = inbox.buildReviews.find((item) => item.businessId === businessId);
  const genericJob = inbox.jobs.find((item) => item.businessId === businessId);

  check('unresolved visual-qa NEEDS_HUMAN is the rich build decision', review?.projectId === projectId, {
    review,
    jobs: inbox.jobs.filter((item) => item.businessId === businessId),
  });
  check('unresolved visual-qa NEEDS_HUMAN has no duplicate generic retry', !genericJob, genericJob);

  // This is the state after «Ще ітерація»: the decision was already given and
  // a new build owns the business, but the old QA journal row used to remain
  // `needs_human` and reappear as the screenshot's fake decision card.
  const claimed = await claimBuildReviewDecision({
    projectId,
    decision: 'another_iteration',
    reason: 'Роман замовив ще одну ітерацію',
  });
  check('operator decision atomically claims the parked build', claimed.kind === 'claimed', claimed);
  const afterDecision = await loadInbox();
  const staleReview = afterDecision.buildReviews.find((item) => item.businessId === businessId);
  const staleJob = afterDecision.jobs.find((item) => item.businessId === businessId);
  check('resolved visual-qa verdict leaves the decision list', !staleReview, staleReview);
  check('resolved visual-qa verdict never resurrects as generic retry', !staleJob, staleJob);
  const closed = await pool.query<{ status: string; error_code: string | null }>(
    `select status, error_code from workflow_jobs where business_id = $1 and job_type = 'visual-qa'`,
    [businessId],
  );
  check(
    'human decision closes the NEEDS_HUMAN journal row',
    closed.rows[0]?.status === 'cancelled' && closed.rows[0]?.error_code === null,
    closed.rows,
  );
  console.log('\n🧪 VISUAL-QA DECISION TEST PASSED');
} finally {
  await pool.query(`delete from workflow_jobs where business_id = $1`, [businessId]).catch(() => {});
  await pool.query(`delete from site_projects where business_id = $1`, [businessId]).catch(() => {});
  await pool.query(`delete from businesses where id = $1`, [businessId]).catch(() => {});
  await pool.query(`delete from campaigns where id = $1`, [campaignId]).catch(() => {});
  await pool.end();
}
