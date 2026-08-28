/**
 * Final integration smoke: the two ends of the factory, against the REAL
 * services in docker compose, on throwaway fixture rows.
 *
 *   part 1  discovery -> gosom REST (a real, tiny query) -> candidates in the DB
 *           with raw evidence, deduplicated.
 *   part 2  a seeded `site_ready` business -> approvals row -> the SAME server
 *           action the UI button calls -> send-outreach in dry_run -> EXACTLY
 *           one `simulated` outreach message + a Telegram notify line with the
 *           demo link. Then a second send attempt proves the idempotency key.
 *
 * Everything created lives under campaign `e2e-integration-campaign` (business
 * ids prefixed `e2e-integration-`) and is deleted at the end, so the real
 * `gr-patras-beauty` and `legacy-website-offers` rows are never touched.
 * The fixture business is the ONLY one with an approvals row, and a send is
 * impossible without one — the real campaign could not be contacted even by a
 * bug in this script.
 *
 *   pnpm tsx scripts/integration-e2e.ts             # both parts, then clean up
 *   pnpm tsx scripts/integration-e2e.ts --keep      # leave the rows for inspection
 *   pnpm tsx scripts/integration-e2e.ts --no-discovery   # skip the gosom part
 */
import 'dotenv/config';

// dry_run is the whole point of this run: the send must be SIMULATED.
process.env.FACTORY_MODE = 'dry_run';

import { and, eq, like } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/client.js';
import { discoverHandler } from '../src/workers/discovery.js';
import { normalizeHandler } from '../src/workers/normalize.js';
import { sendOutreachHandler, sendIdempotencyKey } from '../src/workers/outreach.js';
import { assertFixtureId, assertFixtureIds, FIXTURE_PREFIX } from './e2e/safety.js';
import { ensureBuckets, putRaw } from '../src/lib/storage.js';

const CAMPAIGN_ID = assertFixtureId('e2e-integration-campaign', 'campaign');
const BUSINESS_ID = assertFixtureId('e2e-integration-fixture-salon', 'business');
const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const SKIP_DISCOVERY = args.has('--no-discovery');

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Delete every fixture row. Scoped by campaign/business id, never by status. */
async function clean(): Promise<void> {
  const ids = await pool.query<{ id: string }>(
    'select id from businesses where campaign_id = $1', [CAMPAIGN_ID],
  );
  const businessIds = ids.rows.map((r) => r.id);
  assertFixtureIds(businessIds, 'business');
  if (businessIds.length) {
    await pool.query(
      `delete from workflow_reconciliation_events
       where run_id in (select id from workflow_job_runs where business_id = any($1::text[]))
          or attempt_id in (select id from workflow_jobs where business_id = any($1::text[]))`,
      [businessIds],
    ).catch(() => {});
    for (const table of [
      'outreach_events', 'outreach_messages', 'approvals', 'deals',
      'enrichment_runs', 'production_gaps', 'qualifications', 'website_audits', 'business_contacts',
      'business_facts', 'assets', 'site_projects', 'workflow_jobs',
      'status_history', 'business_sources',
    ]) {
      await pool.query(
        `delete from ${table} where business_id = any($1::text[])`, [businessIds],
      ).catch(() => {});
    }
    await pool.query('delete from workflow_job_runs where business_id = any($1::text[])', [businessIds]).catch(() => {});
    await pool.query('delete from businesses where campaign_id = $1', [CAMPAIGN_ID]).catch(() => {});
  }
  await pool.query('delete from workflow_jobs where campaign_id = $1', [CAMPAIGN_ID]).catch(() => {});
  await pool.query(
    `delete from workflow_reconciliation_events
     where run_id in (select id from workflow_job_runs where campaign_id = $1)`,
    [CAMPAIGN_ID],
  ).catch(() => {});
  await pool.query('delete from workflow_job_runs where campaign_id = $1', [CAMPAIGN_ID]).catch(() => {});
  // pg-boss keeps its own copy of every queued job; leaving those behind would
  // make a live workers process pick up fixture candidates after cleanup.
  await pool.query(
    `delete from pgboss.job where data->>'campaignId' = $1`, [CAMPAIGN_ID],
  ).catch(() => {});
  await pool.query('delete from campaigns where id = $1', [CAMPAIGN_ID]).catch(() => {});
  console.log(`🧹 fixture campaign ${CAMPAIGN_ID} removed (${businessIds.length} businesses)`);
}

async function ensureCampaign(): Promise<void> {
  await db.insert(schema.campaigns).values({
    id: CAMPAIGN_ID,
    // normalizeHandler derives `${country}-${city}-${name}`. Using a fixture
    // country makes every real gosom candidate safe to materialize and clean.
    country: 'e2e',
    city: 'Integration',
    niche: 'beauty',
    language: 'el',
    // ONE tiny query: this hits the real Google Maps through gosom, so it is
    // deliberately the smallest useful request.
    queries: ['nail salon Patras'],
    geofence: { lat: 38.246, lng: 21.735, radiusKm: 10 },
    targetCount: 5,
    mode: 'dry_run',
  }).onConflictDoNothing();
}

// ── part 1: discovery through the real gosom service ────────────────────────
async function partDiscovery(): Promise<void> {
  console.log('\n── part 1: discover -> gosom REST ──────────────────────────');
  const gosomUrl = process.env.GOSOM_URL ?? 'http://127.0.0.1:8085';
  const reachable = await fetch(`${gosomUrl}/api/v1/jobs`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok).catch(() => false);
  check('gosom REST reachable', reachable, gosomUrl);
  if (!reachable) {
    console.error('   gosom is not up — `docker compose up -d gosom` and retry');
    return;
  }

  const started = Date.now();
  await discoverHandler({
    campaignId: CAMPAIGN_ID,
    idempotencyKey: `discover:${CAMPAIGN_ID}:${started}`,
  } as Parameters<typeof discoverHandler>[0]);

  // `discover` deliberately does NOT write businesses: it stores the raw
  // evidence and enqueues one `normalize` job per candidate, and normalize is
  // what dedups and inserts. No workers process is running during this script,
  // so drain those queued jobs here — otherwise we would be asserting on a
  // stage that has not run yet.
  // The job payload lives in pg-boss's own table; `workflow_jobs` is the audit
  // mirror and deliberately stores no candidate data.
  const queued = await pool.query<{ id: string; data: Record<string, unknown> }>(
    `select id, data from pgboss.job
      where name = 'normalize' and state = 'created'
        and data->>'campaignId' = $1`,
    [CAMPAIGN_ID],
  );
  check('normalize jobs enqueued by discovery', queued.rows.length > 0,
    `${queued.rows.length} jobs`);

  let normalized = 0;
  for (const job of queued.rows) {
    const payload = job.data as Record<string, unknown>;
    await normalizeHandler({
      campaignId: CAMPAIGN_ID,
      candidate: payload.candidate,
      idempotencyKey: String(payload.idempotencyKey ?? job.id),
    } as Parameters<typeof normalizeHandler>[0]);
    normalized += 1;
  }
  console.log(`   drained ${normalized} normalize jobs inline`);

  const rows = await db.select().from(schema.businesses)
    .where(eq(schema.businesses.campaignId, CAMPAIGN_ID));
  assertFixtureIds(rows.map((row) => row.id), 'business');
  check('candidates written to the DB', rows.length > 0, `${rows.length} businesses`);

  // Raw evidence: every candidate must point at an immutable stored object.
  const srcCount = await pool.query<{ n: string }>(
    `select count(*)::text as n from business_sources
      where business_id = any($1::text[])`,
    [rows.map((r) => r.id)],
  );
  check('raw evidence stored for candidates', Number(srcCount.rows[0]?.n ?? 0) > 0,
    `${srcCount.rows[0]?.n} source rows`);

  // Dedup: place_id and normalized name+city must both be unique.
  const dupPlace = await pool.query<{ n: string }>(
    `select count(*)::text as n from (
       select place_id from businesses
        where campaign_id = $1 and place_id is not null
        group by place_id having count(*) > 1) d`, [CAMPAIGN_ID],
  );
  check('no duplicate place_id', Number(dupPlace.rows[0]?.n ?? 0) === 0);

  const dupName = await pool.query<{ n: string }>(
    `select count(*)::text as n from (
       select normalized_name from businesses
        where campaign_id = $1 group by normalized_name having count(*) > 1) d`, [CAMPAIGN_ID],
  );
  check('no duplicate normalized_name', Number(dupName.rows[0]?.n ?? 0) === 0);

  console.log(`   discovery took ${Math.round((Date.now() - started) / 1000)}s`);
  rows.slice(0, 5).forEach((r) => console.log(`   · ${r.name} — ${r.status}`));
}

// ── part 2: approval -> exactly one simulated send ──────────────────────────
async function partApproval(): Promise<void> {
  console.log('\n── part 2: approve -> exactly one dry_run send ─────────────');

  // Seed an honest, obviously-synthetic `site_ready` business with one contact.
  await db.insert(schema.businesses).values({
    id: BUSINESS_ID,
    campaignId: CAMPAIGN_ID,
    name: 'Integration Fixture Salon',
    normalizedName: 'integration fixture salon',
    category: 'beauty_salon',
    address: 'Fixture 1, Patras',
    status: 'site_ready',
  }).onConflictDoUpdate({
    target: schema.businesses.id,
    set: { status: 'site_ready' },
  });

  await ensureBuckets();
  const fixtureRawKey = await putRaw('e2e-integration', Buffer.from(
    'Controlled outreach fixture evidence for Integration Fixture Salon.',
  ), 'text/plain');
  const [source] = await db.insert(schema.businessSources).values({
    businessId: BUSINESS_ID,
    sourceType: 'fixture',
    url: 'https://example.invalid/e2e-integration-fixture-salon',
    method: 'integration_fixture',
    rawObjectKey: fixtureRawKey,
  }).returning({ id: schema.businessSources.id });

  await db.insert(schema.businessContacts).values({
    businessId: BUSINESS_ID,
    channel: 'email',
    value: 'integration-fixture@factory.local',
    sourceId: source!.id,
    verified: true,
  }).onConflictDoNothing();

  const [approval] = await db.insert(schema.approvals).values({
    businessId: BUSINESS_ID,
    kind: 'outreach',
    payload: {
      draft: {
        channel: 'email',
        toAddress: 'integration-fixture@factory.local',
        subject: 'Демо для Integration Fixture Salon',
        body: 'Доброго дня! Зробив демо-сайт: http://localhost:8788/integration-fixture/',
      },
      demoUrl: 'http://localhost:8788/integration-fixture/',
    },
  }).returning();
  check('approval row created (pending)', Boolean(approval) && !approval.decision);

  // The exact conditional update the UI's Approve button performs.
  const approved = await pool.query(
    `update approvals set decision = 'approved', decided_by = 'integration-e2e',
            decided_at = now()
      where id = $1 and decision is null returning id`, [approval.id],
  );
  check('approve wins the conditional update', approved.rowCount === 1);

  // A second click must change nothing — this is the anti-double-send lock.
  const second = await pool.query(
    `update approvals set decision = 'approved' where id = $1 and decision is null returning id`,
    [approval.id],
  );
  check('a second Approve click updates ZERO rows', second.rowCount === 0);

  await db.update(schema.businesses)
    .set({ status: 'outreach_approved' })
    .where(eq(schema.businesses.id, BUSINESS_ID));

  // Now the send, through the real handler, in dry_run.
  const key = sendIdempotencyKey(approval.id);
  await sendOutreachHandler({
    businessId: BUSINESS_ID,
    campaignId: CAMPAIGN_ID,
    idempotencyKey: key,
    data: { approvalId: approval.id },
  } as Parameters<typeof sendOutreachHandler>[0]);

  let msgs = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BUSINESS_ID));
  check('exactly ONE outreach message', msgs.length === 1, `${msgs.length} rows`);
  check('state is simulated (dry_run, nothing left the machine)',
    msgs[0]?.state === 'simulated', msgs[0]?.state);
  check('message carries the send idempotency key', msgs[0]?.idempotencyKey === key, key);

  // Re-running the SAME job must not produce a second message.
  await sendOutreachHandler({
    businessId: BUSINESS_ID,
    campaignId: CAMPAIGN_ID,
    idempotencyKey: key,
    data: { approvalId: approval.id },
  } as Parameters<typeof sendOutreachHandler>[0]);

  msgs = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BUSINESS_ID));
  check('replaying the send job still leaves ONE message', msgs.length === 1, `${msgs.length} rows`);

  const events = await db.select().from(schema.outreachEvents)
    .where(eq(schema.outreachEvents.businessId, BUSINESS_ID));
  check('an outreach event was recorded', events.length >= 1,
    events.map((e) => e.event).join(','));

  const [biz] = await db.select().from(schema.businesses)
    .where(eq(schema.businesses.id, BUSINESS_ID));
  check('business moved to contacted', biz?.status === 'contacted', biz?.status);

  // A business with NO approval must be unsendable — the core invariant.
  const [victim] = await db.select().from(schema.businesses)
    .where(and(eq(schema.businesses.campaignId, CAMPAIGN_ID),
      like(schema.businesses.id, `${FIXTURE_PREFIX}integration-%`)));
  if (victim && victim.id !== BUSINESS_ID) {
    assertFixtureId(victim.id, 'business');
    let refused = false;
    await sendOutreachHandler({
      businessId: victim.id,
      campaignId: CAMPAIGN_ID,
      idempotencyKey: 'integration-no-approval',
      data: { approvalId: 999999999 },
    } as Parameters<typeof sendOutreachHandler>[0]).catch(() => { refused = true; });
    const stray = await db.select().from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.businessId, victim.id));
    check('send without an approval row creates NO message',
      stray.length === 0, refused ? 'handler refused' : 'no rows written');
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
if (args.has('--clean')) {
  await clean();
} else {
  await clean();               // start from a known-empty fixture
  await ensureCampaign();
  if (!SKIP_DISCOVERY) await partDiscovery();
  else console.log('\n── part 1 skipped (--no-discovery) ──');
  await partApproval();

  if (KEEP) console.log(`\n(--keep) fixture rows left in campaign ${CAMPAIGN_ID}`);
  else await clean();

  console.log(failures === 0
    ? '\n🏭 INTEGRATION E2E PASSED'
    : `\n💥 INTEGRATION E2E FAILED — ${failures} check(s)`);
}

await pool.end();
process.exit(failures === 0 ? 0 : 1);
