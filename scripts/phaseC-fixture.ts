/**
 * Phase C mechanics rehearsal on an HONEST synthetic business.
 *
 * Creates campaign `e2e-phasec-fixture` with one business whose evidence package is
 * small but real in shape: real source rows, real facts with source ids, real
 * image files as assets. Nothing here is presented as a genuine Patras business —
 * every mutable id is prefixed `e2e-` and `--clean` removes every database trace.
 *
 * Purpose: shake out the plumbing (workspace prep, agent session, independent
 * build verification, provenance grep, QA loop, deploy + health check) without
 * waiting for phase B, and without burning a real business on a bug.
 *
 *   pnpm tsx scripts/phaseC-fixture.ts --seed     # create the fixture
 *   pnpm tsx scripts/phaseC-fixture.ts --run      # seed + full chain
 *   pnpm tsx scripts/phaseC-fixture.ts --clean    # remove everything
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { desc, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/client.js';
import { ensureBuckets, putAsset, putRaw, sha256 } from '../src/lib/storage.js';
import { enqueue, getBoss } from '../src/orchestrator/queue.js';
import { assertFixtureId, FIXTURE_PREFIX } from './e2e/safety.js';

const CAMPAIGN_ID = assertFixtureId('e2e-phasec-campaign', 'campaign');
const BUSINESS_ID = assertFixtureId('e2e-phasec-anemi-studio', 'business');
const args = new Set(process.argv.slice(2));

async function clean(): Promise<void> {
  const projects = await db.select({ dir: schema.siteProjects.dir })
    .from(schema.siteProjects)
    .where(eq(schema.siteProjects.businessId, BUSINESS_ID));
  const allowedRoot = path.resolve(process.env.RUNNER_SITES_ROOT ?? 'sites');
  for (const project of projects) {
    const dir = path.resolve(project.dir);
    if (dir.startsWith(`${allowedRoot}${path.sep}`)) await rm(dir, { recursive: true, force: true });
  }
  await pool.query(
    `delete from workflow_reconciliation_events
     where run_id in (select id from workflow_job_runs where business_id = $1)
        or attempt_id in (select id from workflow_jobs where business_id = $1)`,
    [BUSINESS_ID],
  ).catch(() => {});
  for (const table of [
    'outreach_events', 'outreach_messages', 'approvals', 'deals', 'enrichment_runs',
    'production_gaps', 'qualifications', 'website_audits', 'business_contacts',
    'business_facts', 'assets', 'site_projects', 'workflow_jobs', 'status_history',
    'business_sources',
  ]) {
    await pool.query(`delete from ${table} where business_id = $1`, [BUSINESS_ID]).catch(() => {});
  }
  await pool.query('delete from workflow_job_runs where business_id = $1', [BUSINESS_ID]).catch(() => {});
  await pool.query(
    `delete from pgboss.job where data::text like $1 or singleton_key like $2`,
    [`%${BUSINESS_ID}%`, `${FIXTURE_PREFIX}%`],
  ).catch(() => {});
  await pool.query('delete from businesses where id = $1', [BUSINESS_ID]).catch(() => {});
  await pool.query('delete from campaigns where id = $1', [CAMPAIGN_ID]).catch(() => {});
  console.log('fixture removed');
}

/**
 * Deterministic, obviously-synthetic photographs. Generated with a headless
 * browser rather than shipped as binaries: they are plausible salon imagery in
 * composition and aspect ratio, which is all the pipeline mechanics need.
 */
async function makePhotos(dir: string): Promise<Array<{ file: string; w: number; h: number; kind: string }>> {
  await mkdir(dir, { recursive: true });
  const specs = [
    { name: 'interior.jpg', w: 1600, h: 1067, kind: 'hero', bg: '#d9cfc4', fg: '#6b5544', label: 'INTERIOR' },
    { name: 'detail.jpg', w: 1400, h: 1400, kind: 'gallery', bg: '#c9b9ab', fg: '#4a3a2e', label: 'DETAIL' },
    { name: 'workspace.jpg', w: 1500, h: 1000, kind: 'gallery', bg: '#e3dbd2', fg: '#5c4a3c', label: 'WORKSPACE' },
    { name: 'logo.png', w: 600, h: 600, kind: 'logo', bg: '#ffffff', fg: '#2b2118', label: 'ANEMI' },
  ];
  const browser = await chromium.launch({ headless: true });
  const out: Array<{ file: string; w: number; h: number; kind: string }> = [];
  try {
    for (const s of specs) {
      const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.setContent(`<html><body style="margin:0;width:${s.w}px;height:${s.h}px;
        background:linear-gradient(140deg, ${s.bg}, ${s.fg}22 70%, ${s.bg});
        display:flex;align-items:center;justify-content:center;
        font-family:Georgia,serif;color:${s.fg};letter-spacing:0.3em;font-size:${Math.round(s.w / 18)}px">
        <div style="opacity:.55">${s.label}</div></body></html>`);
      const buf = await page.screenshot({
        type: s.name.endsWith('.png') ? 'png' : 'jpeg',
        ...(s.name.endsWith('.png') ? {} : { quality: 88 }),
      });
      await writeFile(path.join(dir, s.name), buf);
      out.push({ file: s.name, w: s.w, h: s.h, kind: s.kind });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function seed(): Promise<void> {
  await ensureBuckets();
  await clean();

  await db.insert(schema.campaigns).values({
    id: CAMPAIGN_ID, country: 'e2e', city: 'Fixture', niche: 'beauty', language: 'el',
    queries: ['nail salon Patras'], geofence: { lat: 38.246, lng: 21.735, radiusKm: 8 },
    targetCount: 1, status: 'created',
  });

  await db.insert(schema.businesses).values({
    id: BUSINESS_ID, campaignId: CAMPAIGN_ID,
    name: 'Anemi Nail Studio',
    normalizedName: 'anemi nail studio',
    category: 'Nail salon',
    address: 'Riga Feraiou 84, Patras 262 21',
    lat: 38.2466, lng: 21.7346,
    phone: '+30 2610 279 118',
    normalizedPhone: '302610279118',
    placeId: 'FIXTURE-anemi-studio',
    listingUrl: 'https://maps.google.com/?cid=FIXTURE',
    rating: 4.8, reviewCount: 47,
    status: 'production_ready',
  });
  await db.insert(schema.statusHistory).values({
    businessId: BUSINESS_ID, fromStatus: null, toStatus: 'production_ready',
    actor: 'e2e-phasec-fixture', reason: 'synthetic fixture for phase C mechanics',
  });

  const listingRawKey = await putRaw('e2e-phasec', Buffer.from(
    'Controlled fixture listing for Anemi Nail Studio; synthetic acceptance data.',
  ), 'text/plain');
  const siteRawKey = await putRaw('e2e-phasec', Buffer.from(
    '<html lang="el"><body>Anemi Nail Studio fixture evidence</body></html>',
  ), 'text/html');
  const [source] = await db.insert(schema.businessSources).values({
    businessId: BUSINESS_ID, sourceType: 'google_maps',
    url: 'https://maps.google.com/?cid=FIXTURE', method: 'gosom_api',
    rawObjectKey: listingRawKey,
  }).returning();
  const [siteSource] = await db.insert(schema.businessSources).values({
    businessId: BUSINESS_ID, sourceType: 'owned_website',
    url: 'https://anemi-fixture.example.gr/', method: 'playwright',
    rawObjectKey: siteRawKey,
  }).returning();

  const facts: Array<[string, unknown, number]> = [
    ['identity.description', 'Στούντιο περιποίησης νυχιών στο κέντρο της Πάτρας, με έμφαση στη φυσική εμφάνιση και την υγιεινή.', siteSource!.id],
    ['service', { name: 'Manicure', price: '15€' }, siteSource!.id],
    ['service', { name: 'Ημιμόνιμο βερνίκι', price: '20€' }, siteSource!.id],
    ['service', { name: 'Pedicure', price: '25€' }, siteSource!.id],
    ['service', { name: 'Nail art', price: null }, siteSource!.id],
    ['review_excerpt', { text: 'Πολύ προσεγμένη δουλειά και καθαριότητα. Έμεινα ενθουσιασμένη.', rating: 5 }, source!.id],
    ['review_excerpt', { text: 'Συνεπείς στα ραντεβού, εξαιρετικό αποτέλεσμα στο ημιμόνιμο.', rating: 5 }, source!.id],
    ['hours', 'Δευ-Παρ 09:00-20:00, Σαβ 09:00-15:00', siteSource!.id],
    ['social.instagram', 'https://instagram.com/anemi.fixture', siteSource!.id],
  ];
  for (const [key, value, sourceId] of facts) {
    await db.insert(schema.businessFacts).values({
      businessId: BUSINESS_ID, key, value: value as never, sourceId,
      confidence: 0.9, extractionMethod: 'llm_structured', verified: true,
    });
  }

  await db.insert(schema.businessContacts).values([
    { businessId: BUSINESS_ID, channel: 'phone', value: '+30 2610 279 118', sourceId: source!.id, verified: true },
    { businessId: BUSINESS_ID, channel: 'email', value: 'hello@anemi-fixture.example.gr', sourceId: siteSource!.id, verified: true },
    { businessId: BUSINESS_ID, channel: 'instagram', value: 'https://instagram.com/anemi.fixture', sourceId: siteSource!.id, verified: true },
  ]);

  const photoDir = path.resolve('storage', 'fixture-photos');
  const photos = await makePhotos(photoDir);
  for (const p of photos) {
    const buf = await readFile(path.join(photoDir, p.file));
    const hash = sha256(buf);
    const ext = path.extname(p.file);
    const objectKey = `${BUSINESS_ID}/${p.kind}-${hash.slice(0, 12)}${ext}`;
    await putAsset(objectKey, buf, ext === '.png' ? 'image/png' : 'image/jpeg');
    await db.insert(schema.assets).values({
      businessId: BUSINESS_ID, objectKey, hash,
      sourceUrl: `https://anemi-fixture.example.gr/img/${p.file}`,
      sourceType: 'enrichment',
      contentType: ext === '.png' ? 'image/png' : 'image/jpeg',
      width: p.w, height: p.h, intendedUsage: p.kind, rights: 'private_demo_only',
    });
  }

  await db.insert(schema.websiteAudits).values({
    businessId: BUSINESS_ID,
    endpointMatrix: [{ url: 'https://anemi-fixture.example.gr/', status: 200, finalUrl: 'https://anemi-fixture.example.gr/', tlsOk: true, error: null }],
    bestEndpoint: 'https://anemi-fixture.example.gr/',
    verdict: 'working_but_dated', meaningfulContent: true,
    notes: 'Synthetic fixture audit.',
  });

  console.log(`seeded ${BUSINESS_ID} (${photos.length} assets, ${facts.length} facts, 3 contacts)`);
}

async function runChain(): Promise<void> {
  if (process.env.AGENT_EXECUTION_MODE !== 'remote'
    || !(process.env.RUNNER_SITES_ROOT ?? '').startsWith('/app/')) {
    throw new Error(
      'F1 fixture must run inside the factory Compose service with the remote runner; '
      + 'use `docker compose exec factory pnpm tsx scripts/phaseC-fixture.ts --run`',
    );
  }

  const started = Date.now();
  const result = await enqueue('content-and-design', {
    businessId: BUSINESS_ID,
    campaignId: CAMPAIGN_ID,
    idempotencyKey: `e2e-content-and-design:${BUSINESS_ID}:${started}`,
  });
  if (result.kind !== 'accepted') throw new Error(`F1 enqueue was suppressed by run ${result.runId}`);
  console.log(`queued F1 logical run ${result.runId}; workers own every successor stage`);

  const deadline = Date.now() + 90 * 60_000;
  let lastLine = '';
  for (;;) {
    const [business] = await db.select().from(schema.businesses)
      .where(eq(schema.businesses.id, BUSINESS_ID));
    const [project] = await db.select().from(schema.siteProjects)
      .where(eq(schema.siteProjects.businessId, BUSINESS_ID))
      .orderBy(desc(schema.siteProjects.id)).limit(1);
    const runs = await db.select().from(schema.workflowJobRuns)
      .where(eq(schema.workflowJobRuns.businessId, BUSINESS_ID))
      .orderBy(desc(schema.workflowJobRuns.updatedAt));
    const latest = runs[0];
    const line = `business=${business?.status ?? 'missing'} project=${project?.state ?? 'none'} job=${latest?.jobType ?? 'none'}:${latest?.status ?? 'none'}`;
    if (line !== lastLine) {
      console.log(`  ${line}`);
      lastLine = line;
    }

    if (business?.status === 'site_ready' && project?.state === 'deployed' && project.deployUrl) {
      console.log(JSON.stringify({
        ok: true,
        businessId: BUSINESS_ID,
        projectId: project.id,
        deployUrl: project.deployUrl,
        qaIterations: project.qaIterations,
        wallSeconds: Math.round((Date.now() - started) / 1000),
      }, null, 2));
      break;
    }

    const blocking = runs.find((run) => ['failed', 'needs_human'].includes(run.status));
    if (blocking) {
      const [attempt] = await db.select().from(schema.workflowJobs)
        .where(eq(schema.workflowJobs.runId, blocking.id))
        .orderBy(desc(schema.workflowJobs.attemptSequence)).limit(1);
      throw new Error(
        `F1 stopped at ${blocking.jobType}:${blocking.status} — `
        + `${attempt?.errorCode ?? 'UNKNOWN'}: ${attempt?.errorDetail ?? 'no detail'}`,
      );
    }
    if (Date.now() >= deadline) throw new Error(`F1 timed out after 90 minutes (${line})`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  const boss = await getBoss();
  await boss.stop({ close: true, graceful: true, wait: true, timeout: 5_000 });
}

if (args.has('--clean')) {
  await clean();
} else {
  if (args.has('--seed') || args.has('--run')) await seed();
  if (args.has('--run')) await runChain();
  if (!args.has('--seed') && !args.has('--run')) {
    console.log('usage: phaseC-fixture.ts [--seed | --run | --clean]');
  }
}
await pool.end();
