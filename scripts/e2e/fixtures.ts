/**
 * Disposable data for the funnel-mechanics checks.
 *
 * The funnel is the half of the product the 2026-08-20 sweep could NOT test:
 * `approvals`, `outreach_messages`, `outreach_events` and `deals` were all
 * empty, so approve/reject, the manual deep link, follow-up scheduling and the
 * three build-review decisions had never been exercised with real data. They
 * can only be exercised by driving real rows through real actions — which is
 * exactly the thing that must never touch a real salon.
 *
 * So the suite builds its own businesses. Every id starts with `e2e-`,
 * `assertFixtureId` enforces that at each write, and `destroyFixtures` deletes
 * by that prefix in foreign-key order. The census in `harness.ts` proves after
 * the fact that nothing else moved.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFixtureId, sql, sqlOne, FIXTURE_PREFIX } from './harness.js';

export const FIXTURE_CAMPAIGN = 'e2e-fixture-campaign';
export const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

export interface FixtureBusiness {
  id: string;
  name: string;
  projectId?: number;
  deployToken?: string;
  deployDir?: string;
  workspaceDir?: string;
}

export async function createCampaign(): Promise<string> {
  assertFixtureId(FIXTURE_CAMPAIGN);
  await sql(
    `insert into campaigns (id, country, city, niche, language, queries, geofence, target_count, mode, status)
     values ($1, 'gr', 'E2E Town', 'beauty', 'el', $2::jsonb, $3::jsonb, 5, 'dry_run', 'created')
     on conflict (id) do nothing`,
    [FIXTURE_CAMPAIGN, JSON.stringify(['e2e salon']), JSON.stringify({ lat: 38, lng: 21, radiusKm: 5 })],
  );
  return FIXTURE_CAMPAIGN;
}

/**
 * A business plus the evidence chain a real one carries.
 *
 * A bare `businesses` row is not enough to exercise the funnel honestly: the
 * approval card reads the audit verdict, the readiness gate reads gaps, and the
 * data-truth invariants assert that every fact and contact has a `source_id`.
 * A fixture that skipped the source row would make the suite's own invariant
 * check pass for the wrong reason, so the chain is built the way the pipeline
 * builds it — source first, then facts and contacts pointing at it.
 */
export async function createBusiness(input: {
  id: string;
  name: string;
  status: string;
  statusReason?: string;
  score?: number;
  withContact?: boolean;
}): Promise<FixtureBusiness> {
  const id = assertFixtureId(input.id);
  await sql(
    `insert into businesses (id, campaign_id, name, normalized_name, category, address, status, status_reason, score)
     values ($1, $2, $3, $4, 'Beauty salon', '1 E2E St, E2E Town', $5, $6, $7)
     on conflict (id) do update set status = excluded.status, status_reason = excluded.status_reason`,
    [id, FIXTURE_CAMPAIGN, input.name, input.name.toLowerCase(), input.status,
      input.statusReason ?? 'e2e fixture', input.score ?? 80],
  );
  await sql(
    `insert into status_history (business_id, from_status, to_status, reason, actor)
     values ($1, null, $2, 'e2e fixture seed', 'system')`,
    [id, input.status],
  );

  const source = await sqlOne<{ id: number }>(
    `insert into business_sources (business_id, source_type, url, method, raw_object_key)
     values ($1, 'google_maps', 'https://maps.google.com/e2e', 'fixture', $2)
     returning id`,
    [id, `e2e/${id}/raw-1`],
  );
  await sql(
    `insert into business_facts (business_id, key, value, source_id, confidence, extraction_method)
     values ($1, 'identity.brand_name', $2::jsonb, $3, 1.0, 'fixture')`,
    [id, JSON.stringify(input.name), source!.id],
  );
  if (input.withContact !== false) {
    await sql(
      `insert into business_contacts (business_id, channel, value, source_id, verified)
       values ($1, 'email', $2, $3, true)`,
      [id, `${id}@example.invalid`, source!.id],
    );
  }
  await sql(
    `insert into website_audits (business_id, best_endpoint, verdict)
     values ($1, 'https://e2e.invalid', 'none')`,
    [id],
  );
  return { id, name: input.name };
}

/**
 * A deployed demo on disk, so the approval card has something real to link to.
 *
 * The deploy directory is written under `deploys/e2e-<token>` — inside the
 * directory the live demo server already serves, because the privacy checks in
 * group 7 walk every directory there and a fixture that lived somewhere else
 * would be exempt from exactly the rules it should be proving.
 */
export async function createSiteProject(biz: FixtureBusiness, state: string, opts: {
  deployed?: boolean;
  qaIterations?: number;
  /**
   * Give the project a workspace directory on disk.
   *
   * «Ще спроба» writes the operator's note into the build workspace BEFORE it
   * enqueues anything, and the factory refuses with «Воркспейс цієї збірки
   * більше не на диску» when `<dir>/package.json` is missing — correct product
   * behaviour, and the reason a workspace-less fixture can only ever test the
   * refusal. A fixture that wants to reach the enqueue must look like a real
   * build, which means a real directory.
   */
  withWorkspace?: boolean;
} = {}): Promise<FixtureBusiness> {
  assertFixtureId(biz.id);
  // Shaped like a REAL deploy token — `[a-z0-9]{16,}`, no hyphen — because the
  // privacy checks assert the demo server's own token rules, and a fixture that
  // could not satisfy `DEMO_TOKEN` (src/lib/serveDir.ts) would be exempt from
  // the Referer re-rooting path it is supposed to be exercising. `e2e` stays as
  // an alphanumeric leading marker so teardown can still recognise it.
  const token = `e2e${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, '');
  const dir = path.join(ROOT, 'deploys', token);
  let deployUrl: string | null = null;

  if (opts.deployed) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'),
      '<!doctype html><html lang="el"><head><meta charset="utf-8">'
      + '<meta name="robots" content="noindex, nofollow">'
      + `<title>${biz.name}</title></head><body><h1>${biz.name}</h1>`
      + '<p>e2e fixture demo</p></body></html>', 'utf8');
    deployUrl = `${process.env.DEMO_BASE_URL ?? 'http://localhost:8788'}/${token}/`;
  }

  const project = await sqlOne<{ id: number }>(
    `insert into site_projects (business_id, dir, state, qa_iterations, deploy_url, deploy_token, deployed_at, build_ok, open_issues)
     values ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)
     returning id`,
    [biz.id, '', state, opts.qaIterations ?? 0,
      deployUrl, opts.deployed ? token : null, opts.deployed ? new Date() : null,
      JSON.stringify(state === 'needs_human_review' ? ['[high] e2e fixture open issue'] : [])],
  );

  /**
   * `dir` is resolved INSIDE THE FACTORY CONTAINER, not on the host.
   *
   * `existsSync(path.join(project.dir, 'package.json'))` runs in the factory
   * process, where `./sites` is mounted at `/app/sites` (docker-compose.yml).
   * Storing the host path here makes every workspace look missing to the very
   * check «Ще спроба» performs first — which is exactly how this fixture failed
   * before: the action correctly refused with «Воркспейс цієї збірки більше не
   * на диску», and the gate read a real refusal as a broken button.
   *
   * The directory is created on the HOST path (same bind mount, other side) and
   * recorded under the CONTAINER path.
   */
  const relDir = path.join('sites', biz.id, String(project!.id));
  const hostDir = path.join(ROOT, relDir);
  const containerDir = path.posix.join(process.env.E2E_FACTORY_ROOT ?? '/app', relDir);
  if (opts.withWorkspace) {
    await mkdir(hostDir, { recursive: true });
    await writeFile(path.join(hostDir, 'package.json'),
      JSON.stringify({ name: 'e2e-fixture-site', private: true, version: '0.0.0' }, null, 2), 'utf8');
  }
  await sql(`update site_projects set dir = $1 where id = $2`, [containerDir, project!.id]);
  const workspace = opts.withWorkspace ? hostDir : undefined;

  return {
    ...biz,
    projectId: project!.id,
    deployToken: opts.deployed ? token : undefined,
    deployDir: opts.deployed ? dir : undefined,
    workspaceDir: workspace,
  };
}

/** A pending outreach approval — the row whose absence was sweep P0-1. */
export async function createApproval(biz: FixtureBusiness, channel = 'email'): Promise<number> {
  assertFixtureId(biz.id);
  const row = await sqlOne<{ id: number }>(
    `insert into approvals (business_id, kind, payload)
     values ($1, 'outreach', $2::jsonb)
     returning id`,
    [biz.id, JSON.stringify({
      queueReason: 'e2e fixture: демо готове',
      websiteVerdict: 'none',
      draft: {
        channel,
        toAddress: channel === 'email' ? `${biz.id}@example.invalid` : '+30000000000',
        subject: 'E2E fixture subject',
        body: 'E2E fixture body — це тестове повідомлення, воно нікуди не піде.',
      },
    })],
  );
  return row!.id;
}

/** A failed workflow job, for the Система jobs-UX check. */
export async function createFailedJob(biz: FixtureBusiness, jobType = 'enrich'): Promise<number> {
  assertFixtureId(biz.id);
  const row = await sqlOne<{ id: number }>(
    `insert into workflow_jobs (job_type, business_id, campaign_id, idempotency_key, status, attempts, error_code, error_detail, created_at, finished_at)
     values ($1, $2, $3, $4, 'failed', 3, 'E2EError', 'e2e fixture failure', now(), now())
     returning id`,
    [jobType, biz.id, FIXTURE_CAMPAIGN, `${FIXTURE_PREFIX}job:${biz.id}:${Date.now()}`],
  );
  return row!.id;
}

/** The workflow-journal half of a build waiting for Roman's QA decision. */
export async function createNeedsHumanVisualQaJob(
  biz: FixtureBusiness,
  projectId: number,
): Promise<number> {
  assertFixtureId(biz.id);
  const row = await sqlOne<{ id: number }>(
    `insert into workflow_jobs
       (job_type, business_id, campaign_id, idempotency_key, payload, status,
        attempts, error_code, error_detail, created_at, finished_at)
     values ('visual-qa', $1, $2, $3, $4::jsonb, 'needs_human', 1,
       'NEEDS_HUMAN', 'e2e visual QA verdict', now(), now())
     returning id`,
    [biz.id, FIXTURE_CAMPAIGN, `${FIXTURE_PREFIX}visual-qa:${biz.id}:${projectId}`,
      JSON.stringify({ projectId, iteration: 2 })],
  );
  return row!.id;
}

/**
 * Teardown, in foreign-key order, by prefix only.
 *
 * `pgboss.job` is included deliberately. Enqueuing through the real queue is
 * the only honest way to assert "«Ще спроба» enqueues exactly one build-site",
 * and a pg-boss row left behind would be picked up by a live worker minutes
 * later and start a real build on a business that no longer exists.
 */
export async function destroyFixtures(): Promise<void> {
  const like = `${FIXTURE_PREFIX}%`;

  // Directories first: a deploy dir orphaned by a failed DB delete is invisible
  // to the SQL leftover check but very visible to the privacy walk.
  const tokens = await sql<{ deploy_token: string }>(
    `select deploy_token from site_projects where business_id like $1 and deploy_token is not null`, [like]);
  for (const t of tokens) {
    // Tokens are alphanumeric (see `createSiteProject`), so the marker is the
    // bare `e2e` prefix rather than the hyphenated row-id prefix.
    if (!/^e2e[a-z0-9]+$/i.test(t.deploy_token ?? '')) continue;
    await rm(path.join(ROOT, 'deploys', t.deploy_token), { recursive: true, force: true });
  }
  // Build workspaces (`sites/e2e-…/`) — same reasoning: a directory the DB no
  // longer points at is invisible to the leftover query but still on disk.
  const workspaces = await sql<{ id: string }>(
    `select id from businesses where id like $1`, [like]);
  for (const w of workspaces) {
    await rm(path.join(ROOT, 'sites', assertFixtureId(w.id)), { recursive: true, force: true });
  }

  await sql(`delete from workflow_reconciliation_events
    where attempt_id in (select id from workflow_jobs where business_id like $1)
       or run_id in (select id from workflow_job_runs where business_id like $1)`, [like]).catch(() => {});

  const byBusiness = [
    'outreach_events', 'outreach_messages', 'approvals', 'deals', 'do_not_contact',
    'site_projects', 'production_gaps', 'qualifications', 'website_audits',
    'business_facts', 'business_contacts', 'business_sources',
    'status_history', 'workflow_jobs',
  ];
  for (const table of byBusiness) {
    const col = table === 'do_not_contact' ? 'value' : 'business_id';
    await sql(`delete from ${table} where ${col} like $1`, [like]).catch(() => {});
  }
  // do_not_contact also keys on match_type='business_id'
  await sql(`delete from do_not_contact where value like $1`, [like]).catch(() => {});
  await sql(`delete from workflow_jobs where idempotency_key like $1`, [like]).catch(() => {});
  await sql(`delete from workflow_job_runs where business_id like $1 or idempotency_key like $1`, [like]).catch(() => {});
  await sql(`delete from businesses where id like $1`, [like]);
  await sql(`delete from campaigns where id like $1`, [like]);

  // pg-boss keeps its own copy of the queue.
  await sql(`delete from pgboss.job where singleton_key like $1 or data::text like $2`,
    [like, `%${FIXTURE_PREFIX}%`]).catch(() => {});
  await sql(`delete from pgboss.job where name = 'build-site' and data->>'projectId' is not null
             and not exists (select 1 from site_projects sp where sp.id::text = data->>'projectId')`)
    .catch(() => {});
}

/** Rows still matching the fixture prefix — must be empty after teardown. */
export async function leftoverFixtures(): Promise<string[]> {
  const like = `${FIXTURE_PREFIX}%`;
  const leftovers: string[] = [];
  const checks: Array<[string, string, string]> = [
    ['businesses', 'id', like],
    ['campaigns', 'id', like],
    ['workflow_jobs', 'business_id', like],
    ['workflow_job_runs', 'business_id', like],
    ['production_gaps', 'business_id', like],
    ['approvals', 'business_id', like],
    ['outreach_messages', 'business_id', like],
    ['outreach_events', 'business_id', like],
    ['status_history', 'business_id', like],
    ['site_projects', 'business_id', like],
    ['business_facts', 'business_id', like],
    ['business_contacts', 'business_id', like],
    ['business_sources', 'business_id', like],
    ['deals', 'business_id', like],
  ];
  for (const [table, col, pattern] of checks) {
    const rows = await sql<{ n: string }>(
      `select count(*)::int n from ${table} where ${col} like $1`, [pattern]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) leftovers.push(`${table}=${n}`);
  }
  const boss = await sql<{ n: string }>(
    `select count(*)::int n from pgboss.job where singleton_key like $1`, [like]).catch(() => []);
  if (Number(boss[0]?.n ?? 0) > 0) leftovers.push(`pgboss.job=${boss[0]!.n}`);
  return leftovers;
}
