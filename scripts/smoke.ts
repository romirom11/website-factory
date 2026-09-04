/**
 * Smoke test: exercises the deterministic pipeline end-to-end without LLM agents
 * and without live Google Maps:
 *   campaign -> synthetic candidate -> normalize (dedup) -> fast-qualify
 *   -> website audit (real browser on a controlled local page) -> queue round-trip.
 * Run: pnpm test:smoke:compose
 */
import { eq } from 'drizzle-orm';
import http from 'node:http';
import { db, schema, pool } from '../src/db/client.js';
import { ensureBuckets, putRaw } from '../src/lib/storage.js';
import { normalizeHandler } from '../src/workers/normalize.js';
import { fastQualifyHandler } from '../src/workers/fastQualify.js';
import { auditHandler } from '../src/workers/audit.js';
import { readinessHandler } from '../src/workers/readiness.js';
import { getBoss, register, enqueue } from '../src/orchestrator/queue.js';
import type { RawCandidate } from '../src/discovery/candidate.js';
import { assertFixtureId } from './e2e/safety.js';
import { assertFactoryTaskIsolated } from './e2e/isolation.js';

assertFactoryTaskIsolated('smoke');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const CID = assertFixtureId('e2e-smoke-campaign', 'campaign');
const EVIDENCE_PREFIXES = ['smoke/%', 'e2e-smoke/%'] as const;

async function cleanSmoke(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Older smoke runs could attach their source to a real business through the
    // production dedup policy. Remove only rows backed by the unmistakable smoke
    // evidence namespace; never remove the business they happened to target.
    await client.query(
      `delete from business_facts
       where source_id in (
         select id from business_sources where raw_object_key like any($1::text[])
       )`,
      [EVIDENCE_PREFIXES],
    );
    await client.query(
      `delete from business_contacts
       where source_id in (
         select id from business_sources where raw_object_key like any($1::text[])
       )`,
      [EVIDENCE_PREFIXES],
    );
    await client.query(
      'delete from business_sources where raw_object_key like any($1::text[])',
      [EVIDENCE_PREFIXES],
    );

    const ids = (await client.query<{ id: string }>(
      'select id from businesses where campaign_id = $1',
      [CID],
    )).rows.map((row) => assertFixtureId(row.id, 'business'));
    await client.query(
      `delete from workflow_reconciliation_events
       where run_id in (select id from workflow_job_runs where campaign_id = $1)
          or attempt_id in (select id from workflow_jobs where campaign_id = $1)`,
      [CID],
    );
    for (const table of [
      'enrichment_runs', 'production_gaps', 'qualifications', 'website_audits',
      'business_contacts', 'business_facts', 'business_sources', 'workflow_jobs',
      'status_history',
    ]) {
      await client.query(`delete from ${table} where business_id = any($1::text[])`, [ids]);
    }
    await client.query('delete from workflow_jobs where campaign_id = $1', [CID]);
    await client.query('delete from workflow_job_runs where campaign_id = $1', [CID]);
    await client.query(
      `delete from pgboss.job
       where data->>'campaignId' = $1 or data->>'businessId' = any($2::text[])`,
      [CID, ids],
    );
    await client.query('delete from businesses where id = any($1::text[])', [ids]);
    await client.query('delete from campaigns where id = $1', [CID]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Smoke Salon</title></head>
  <body><h1>Smoke Salon</h1><p>${'Beauty services in Smoketown. '.repeat(30)}</p></body></html>`);
});
let serverListening = false;
let queueStarted = false;

try {
await ensureBuckets();
await cleanSmoke();

await db.insert(schema.campaigns).values({
  // The deterministic normalizer derives ids as country-city-name. A fixture
  // country is intentional: every created business is fail-closed under e2e-*.
  id: CID, country: 'e2e', city: 'Smoketown', niche: 'beauty', language: 'el',
  queries: ['nail salon'], geofence: { lat: 38, lng: 21, radiusKm: 10 }, targetCount: 5,
});
check('campaign created', true);

// local demo website for the audit stage (controlled, no external network)
await new Promise<void>((r) => server.listen(4567, r));
serverListening = true;

// ── normalize + dedup ──
//
// The fixture cites an immutable evidence object, so that object has to really
// EXIST. Every verified contact this run creates points at this key, and the
// e2e gate checks precisely that invariant — a `business_sources` row naming an
// object nobody ever wrote is the evidence-layer equivalent of an invented
// fact. This was a hardcoded `'smoke/raw-1'` that was never stored; it stayed
// invisible only because the gate samples ten businesses and the real ones
// crowded the smoke rows out of the query.
const runToken = `${Date.now()}-${process.pid}`;
const fixtureName = `E2E Smoke Nails ${runToken}`;
const fixturePhone = `+30 999 ${runToken}`;
const fixtureEmail = `e2e-smoke-${runToken}@example.invalid`;
const fixturePlaceId = `e2e-smoke-place-${runToken}`;
const smokeRawKey = await putRaw('e2e-smoke', Buffer.from(
  `<html><body>fixture listing: ${fixtureName}, 1 Test St, Smoketown, `
  + `${fixturePhone}, ${fixtureEmail}</body></html>`,
), 'text/html');

const candidate = {
  name: fixtureName, category: 'Nail salon', address: '1 Test St, Smoketown',
  phone: fixturePhone, email: fixtureEmail,
  // A shared localhost domain would itself be a global dedup key. The audit
  // target is attached only after this fixture has materialized safely.
  websiteUrl: null,
  listingUrl: `https://maps.google.com/maps/place/e2e-smoke?x=!19s${fixturePlaceId}`,
  placeId: fixturePlaceId,
  rating: 4.8, reviewCount: 52, lat: 38.0, lng: 21.0,
  rawObjectKey: smokeRawKey, query: 'nail salon',
} satisfies RawCandidate;
await normalizeHandler({ campaignId: CID, candidate });
let bizRows = await pool.query(`select * from businesses where campaign_id = $1`, [CID]);
check('normalize materialized business', bizRows.rowCount === 1, bizRows.rows[0]?.id);
if (bizRows.rowCount !== 1) throw new Error('smoke normalizer did not create exactly one fixture business');
const businessId = bizRows.rows[0].id as string;
assertFixtureId(businessId, 'business');

// dedup: the same place found again (another query, another listing URL)
// must NOT create a second business — but its source is evidence and is kept.
await normalizeHandler({
  campaignId: CID,
  candidate: {
    ...candidate,
    name: `${fixtureName} DUPLICATE`,
    listingUrl: `${candidate.listingUrl}&hl=el`,
  },
});
bizRows = await pool.query(`select * from businesses where campaign_id = $1`, [CID]);
check('dedup by place_id', bizRows.rowCount === 1);
const srcCount = await pool.query(`select count(*)::int n from business_sources where business_id = $1`, [businessId]);
check('duplicate attached as source', srcCount.rows[0].n >= 2, `sources=${srcCount.rows[0].n}`);
// An identical re-delivery (same listing URL) is the same source, not a new
// one: attachSource is idempotent per (business, url, method) since PR #1.
await normalizeHandler({ campaignId: CID, candidate });
const srcAgain = await pool.query(`select count(*)::int n from business_sources where business_id = $1`, [businessId]);
check('re-delivered candidate does not duplicate its source', srcAgain.rows[0].n === srcCount.rows[0].n, `sources=${srcAgain.rows[0].n}`);

const contactChannels = await pool.query(
  `select channel from business_contacts where business_id = $1 order by channel`, [businessId]);
check('phone + email contacts stored with source', contactChannels.rowCount === 2,
  contactChannels.rows.map((r: any) => r.channel).join(','));
const contactSrc = await pool.query(
  `select count(*)::int n from business_contacts where business_id = $1 and source_id is null`, [businessId]);
check('every contact carries a source_id', contactSrc.rows[0].n === 0);

// ── gosom CSV mapping (no network: the parser is what breaks on a gosom bump) ──
{
  const { parseCsv, mapCsvToCandidates, appendCity } = await import('../src/workers/discovery.js');
  // gosom embeds JSON blobs with commas, quotes and newlines inside CSV cells
  const csv = [
    'input_id,link,title,category,address,website,phone,review_count,review_rating,latitude,longitude,place_id,emails',
    '1,https://maps.google.com/?cid=1,"Nails, Best","Nail salon","3 Rigа St, Patras",https://nails.gr,+30 2610 111111,52,4.8,38.24,21.73,ChIJabc,"a@nails.gr, b@nails.gr"',
    '2,https://maps.google.com/?cid=2,"Say ""Hi"" Beauty",Beauty salon,"Line1',
    'Line2, Patras",,+30 2610 222222,7,4.1,38.25,21.74,ChIJdef,',
  ].join('\n');
  const rows = parseCsv(csv);
  check('csv parser handles quotes/commas/newlines', rows.length === 3, `rows=${rows.length}`);
  const cands = mapCsvToCandidates(csv, 'nail salon Patras', 'raw/key-1');
  check('csv -> 2 candidates', cands.length === 2, `n=${cands.length}`);
  check('quoted comma name preserved', cands[0]?.name === 'Nails, Best', cands[0]?.name);
  check('escaped quotes preserved', cands[1]?.name === 'Say "Hi" Beauty', cands[1]?.name);
  check('first email extracted', cands[0]?.email === 'a@nails.gr', String(cands[0]?.email));
  check('missing email -> null', cands[1]?.email === null, String(cands[1]?.email));
  check('numeric fields typed', cands[0]?.rating === 4.8 && cands[0]?.reviewCount === 52 && cands[0]?.lat === 38.24);
  check('multiline address cell kept whole', cands[1]?.address?.includes('Line2') === true, cands[1]?.address ?? '');
  // city is appended per script: Greek queries already carry the Greek city name
  check('city appended to latin query', appendCity('hair salon', 'Patras') === 'hair salon Patras');
  check('city not duplicated', appendCity('hair salon Patras', 'Patras') === 'hair salon Patras');
  check('greek query left alone', appendCity('κομμωτήριο Πάτρα', 'Patras') === 'κομμωτήριο Πάτρα');
}

// ── fast qualification ──
await fastQualifyHandler({ businessId });
let biz = (await pool.query(`select * from businesses where id = $1`, [businessId])).rows[0];
check('fast-qualify -> prequalified', biz.status === 'prequalified', biz.status);

// illegal transition guard
const { businessTransitions } = await import('../src/orchestrator/statuses.js');
let threw = false;
try {
  await businessTransitions.normal({
    businessId,
    expectedStatus: 'prequalified',
    to: 'contacted',
    actor: 'smoke-worker',
  });
} catch { threw = true; }
check('illegal transition blocked', threw);

// ── website audit (domain=localhost won't parse; set domain manually) ──
await pool.query(`update businesses set domain = 'localhost:4567', website_url = 'http://localhost:4567' where id = $1`, [businessId]);
await auditHandler({ businessId });
const audit = (await pool.query(`select * from website_audits where business_id = $1`, [businessId])).rows[0];
check('audit produced verdict', !!audit?.verdict, audit?.verdict);
check('audit took screenshots', !!audit?.desktop_screenshot_key && !!audit?.mobile_screenshot_key);

// ── readiness gate: no facts/assets yet -> must record gaps, not pass ──
await businessTransitions.override({
  businessId,
  expectedStatus: 'prequalified',
  to: 'qualified',
  actor: 'smoke-test',
  reason: 'exercise readiness gate',
});
await readinessHandler({ businessId });
const gaps = await pool.query(`select gap from production_gaps where business_id = $1 and resolved = false`, [businessId]);
check('readiness gate blocks incomplete package', gaps.rowCount! >= 3, gaps.rows.map((g: any) => g.gap).join(','));

// ── queue round-trip ──
queueStarted = true;
await register('daily-summary', (await import('../src/workers/summary.js')).dailySummaryHandler);
await enqueue('daily-summary', { idempotencyKey: `e2e-smoke-summary-${Date.now()}`, silent: true });
await new Promise((r) => setTimeout(r, 5000));
const jobRow = await pool.query(`select status from workflow_jobs where job_type = 'daily-summary' order by created_at desc limit 1`);
check('pg-boss queue round-trip', jobRow.rows[0]?.status === 'succeeded', jobRow.rows[0]?.status);

// status history is append-only and complete
const history = await pool.query(`select to_status from status_history where business_id = $1 order by at`, [businessId]);
check('status history recorded', history.rowCount! >= 2, history.rows.map((h: any) => h.to_status).join(' -> '));
} catch (error) {
  failures++;
  console.error('❌ smoke execution failed', error);
} finally {
  if (serverListening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }).catch((error) => {
      failures++;
      console.error('❌ smoke HTTP server cleanup failed', error);
    });
  }
  if (queueStarted) {
    await getBoss()
      .then((boss) => boss.stop({ close: true, timeout: 2000 }))
      .catch((error) => {
        failures++;
        console.error('❌ smoke queue cleanup failed', error);
      });
  }
  await cleanSmoke().catch((error) => {
    failures++;
    console.error('❌ smoke fixture cleanup failed', error);
  });
  await pool.end();
}

console.log(failures === 0 ? '\n🏭 SMOKE TEST PASSED' : `\n💥 ${failures} smoke checks failed`);
process.exitCode = failures === 0 ? 0 : 1;
