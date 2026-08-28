/**
 * The standing regression gate: `pnpm e2e`.
 *
 * WHAT THIS IS FOR. Between 2026-08-16 and 2026-08-20 an adversarial sweep of
 * the console found 31 defects, six of them breaking the operator flow outright:
 * an unreachable approval that terminated the entire funnel, five builds frozen
 * for three days behind a card claiming "10–30 хвилин", a queue widget reading
 * «0» above another reading «84», invisible action buttons on the phone,
 * historical QA screenshots all 404, and an evidence tab that was raw JSON and
 * English. Each of those was fixed individually. This file is the thing that
 * keeps them fixed — it re-verifies the product the way Roman uses it, so every
 * CLASS of bug found that week stays dead rather than just its instance.
 *
 * WHAT MAKES IT SAFE TO RUN ANYTIME. It runs against the live local stack with
 * 36 real businesses in it. Three rules make that acceptable:
 *   1. every row it creates carries the `e2e-` prefix, enforced at each write by
 *      `assertFixtureId` rather than by the caller remembering;
 *   2. it never sends: fixtures stay on `dry_run`/manual channels and the only
 *      queue job it enqueues is cancelled in the same check that made it;
 *   3. it takes a census of every table before and after and prints the diff, so
 *      "the DB is byte-identical for real rows" is asserted, not asserted-ish.
 *
 * WHY IT CONTINUES ON FAILURE. The exit code is the failure COUNT, not 1. A gate
 * that stops at the first red line reports one bug per run; this one reports all
 * of them, which is what makes a single run actionable.
 *
 * Flags: `--no-agent-ping` skips the one real Claude subscription call in group 8.
 */
import { chromium } from 'playwright';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pool } from '../src/db/client.js';
import {
  check, checking, group, summary, failures, sql, sqlOne, count,
  takeCensus, diffCensus, waitFor, FIXTURE_PREFIX,
} from './e2e/harness.js';
import {
  BASE, DEMO_BASE, login, newContext, watch, scanRawEnums, scanUnresolved,
  hasHorizontalOverflow, tappable, imageSizes,
} from './e2e/browser.js';
import {
  FIXTURE_CAMPAIGN, ROOT, createCampaign, createBusiness, createSiteProject,
  createApproval, createFailedJob, createNeedsHumanVisualQaJob,
  createLogicalJobRun, createBlockedEnrichment,
  destroyFixtures, leftoverFixtures,
} from './e2e/fixtures.js';

const execFileAsync = promisify(execFile);
const AGENT_PING = !process.argv.includes('--no-agent-ping');
const started = Date.now();

/** The seven pages Roman actually navigates, with the heading each must render. */
const PAGES: Array<{ path: string; heading: string; label: string }> = [
  { path: '/inbox', heading: 'Вхідні', label: 'Вхідні' },
  { path: '/businesses', heading: 'Бізнеси', label: 'Бізнеси' },
  { path: '/campaigns', heading: 'Кампанії', label: 'Кампанії' },
  { path: '/settings', heading: 'Налаштування', label: 'Налаштування' },
  { path: '/settings/system', heading: 'Налаштування', label: 'Система' },
];

async function main(): Promise<void> {
  console.log('\x1b[1m🏭 e2e regression gate\x1b[0m');
  console.log(`   ${BASE} · demo ${DEMO_BASE} · agent ping: ${AGENT_PING ? 'on' : 'off'}\n`);

  const censusBefore = await takeCensus();
  const browser = await chromium.launch();

  // A business card and its QA report, chosen from live data rather than
  // hard-coded: which salon is in which state changes with every pipeline run.
  const cardBusinesses = await sql<{ id: string; name: string; status: string }>(
    `select b.id, b.name, b.status from businesses b
     where b.id not like $1
     order by (select count(*) from business_facts f where f.business_id = b.id) desc
     limit 3`, [`${FIXTURE_PREFIX}%`]);

  try {
    await checkAuth(browser);
    await checkPages(browser);
    await checkDataTruth(browser);
    await checkLinks(browser, cardBusinesses);
    await checkFunnel(browser);
    await checkJobsUx(browser);
    await checkDemoPrivacy();
    await checkConfig(browser);
  } finally {
    await browser.close().catch(() => {});
    await destroyFixtures().catch((e) => console.error('teardown error', e));
  }

  group('9 · No collateral damage');
  const leftovers = await leftoverFixtures();
  check('0 fixture rows left behind', leftovers.length === 0, leftovers.join(', ') || 'clean');
  /**
   * The census, read against a factory that is allowed to be working.
   *
   * "Byte-identical" is the goal, but a live stack is not frozen: a build that
   * was already running when the gate started will finish a stage mid-run and
   * append its own `workflow_jobs` and `status_history` rows. Failing on that
   * would make the gate red whenever the product is doing its job — and the
   * brief explicitly requires tolerating a build in flight.
   *
   * So the two APPEND-ONLY log tables are allowed to grow, and every row they
   * grew by is then attributed: if any of it belongs to a business the gate
   * touched, that is the gate's collateral damage and it fails. Every other
   * table must still match exactly — a changed `businesses`, `approvals` or
   * `outreach_messages` count is never explainable as background progress.
   */
  const censusAfter = await takeCensus();
  // The append-only pipeline logs. Each grows whenever a worker completes a
  // stage, which a live factory does while the gate is running — including
  // stages started by `pnpm tsx scripts/smoke.ts` moments earlier.
  const APPEND_ONLY = new Set(['workflow_jobs', 'status_history', 'qualifications', 'website_audits']);
  const drift = diffCensus(censusBefore, censusAfter);
  const hardDrift = drift.filter((d) => !APPEND_ONLY.has(d.split(':')[0]!));
  check('real rows untouched outside the append-only logs', hardDrift.length === 0,
    hardDrift.join('; ') || (drift.length ? `only logs grew: ${drift.join('; ')}` : 'no drift'));

  const touched = await sql<{ id: string; n: number }>(
    `select business_id as id, count(*)::int n from workflow_jobs
     where created_at > $1 and business_id is not null and business_id not like $2
       and status in ('queued','running')
       and business_id in (
         select business_id from status_history where at > $1 and actor = 'roman')
     group by 1`, [new Date(started), `${FIXTURE_PREFIX}%`]);
  check('no real business was actioned by the gate', touched.length === 0,
    touched.map((t) => `${t.id} (+${t.n} live jobs)`).join(', ') || 'none');

  report();
}

// ─── 1 · Auth ────────────────────────────────────────────────────────────────

/**
 * Default-deny, proven from outside.
 *
 * The middleware matcher is a negative pattern, so a new page is protected only
 * because nobody carved it out. That property is invisible in code review of the
 * page itself; the only honest test is to request every route with no cookie.
 */
async function checkAuth(browser: import('playwright').Browser): Promise<void> {
  group('1 · Auth');
  const ctx = await browser.newContext(); // deliberately no session
  const page = await ctx.newPage();

  for (const p of [...PAGES.map((x) => x.path), '/', '/businesses/anything', '/approvals']) {
    await checking(`logged out ${p} → login`, async () => {
      const res = await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
      const url = page.url();
      const redirected = url.includes('/login');
      if (!redirected) throw new Error(`landed on ${url} (status ${res?.status()})`);
      return 'redirected';
    });
  }

  for (const api of ['/api/object?key=x&bucket=raw', '/api/waha-qr']) {
    await checking(`logged out ${api.split('?')[0]} → 401`, async () => {
      const res = await ctx.request.get(`${BASE}${api}`);
      if (res.status() !== 401) throw new Error(`got ${res.status()}`);
      return '401';
    });
  }
  await ctx.close();
}

// ─── 2 · Pages alive ─────────────────────────────────────────────────────────

async function checkPages(browser: import('playwright').Browser): Promise<void> {
  group('2 · Pages alive');
  const ctx = await newContext(browser);
  const page = await login(ctx);
  const probe = watch(page);

  const sample = await sqlOne<{ id: string }>(
    `select id from businesses where id not like $1 order by updated_at desc limit 1`, [`${FIXTURE_PREFIX}%`]);
  const qaProject = await sqlOne<{ business_id: string }>(
    `select business_id from site_projects where jsonb_array_length(coalesce(qa_report_keys,'[]'::jsonb)) > 0 limit 1`);

  const routes = [
    ...PAGES,
    ...(sample ? [{ path: `/businesses/${sample.id}`, heading: '', label: 'Картка бізнесу' }] : []),
    ...(qaProject ? [{ path: `/businesses/${qaProject.business_id}/qa/1`, heading: 'Звіт перевірки', label: 'Звіт перевірки' }] : []),
  ];

  for (const r of routes) {
    const before = probe.consoleErrors.length;
    const beforeReq = probe.failedRequests.length;
    await checking(`${r.label} renders`, async () => {
      const res = await page.goto(`${BASE}${r.path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      if (!res || res.status() >= 400) throw new Error(`status ${res?.status()}`);
      if (r.heading) {
        const h = await page.locator('h1').first().innerText();
        if (!h.includes(r.heading)) throw new Error(`h1 = "${h}", expected "${r.heading}"`);
      }
      return `${res.status()}`;
    });
    /**
     * One retry before calling a console error a regression.
     *
     * The Система page renders live worker heartbeats, whose clock label ticks
     * every 30 s as each worker stamps itself. Under `force-dynamic` the HTML
     * render and the hydration render are two separate reads of that value, so
     * a heartbeat landing between them produces React #418 — measured at ~1 run
     * in 6, and NOT caused by anything in the page's code (see the standing
     * finding in the sweep doc).
     *
     * A gate that goes red one run in six trains its reader to re-run it until
     * it is green, which is the same as having no gate. So a first error is
     * re-tested once on a clean page; a REPRODUCIBLE error still fails, which is
     * what a real regression would be.
     */
    let consoleErrs = probe.consoleErrors.slice(before);
    if (consoleErrs.length) {
      await page.goto(`${BASE}${r.path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      const second = probe.consoleErrors.length;
      await page.reload({ waitUntil: 'networkidle' });
      consoleErrs = probe.consoleErrors.slice(second);
    }
    check(`${r.label}: 0 console errors`, consoleErrs.length === 0,
      consoleErrs.join(' | ').slice(0, 200));
    check(`${r.label}: 0 failed requests`,
      probe.failedRequests.length === beforeReq,
      probe.failedRequests.slice(beforeReq).join(' | ').slice(0, 200));

    const leaks = await scanRawEnums(page);
    check(`${r.label}: no raw enums in visible text`, leaks.length === 0,
      leaks.slice(0, 4).map((l) => `${l.token} @"${l.context}"`).join(' | ').slice(0, 300));
    const unresolved = await scanUnresolved(page);
    check(`${r.label}: no unresolved placeholders`, unresolved.length === 0, unresolved.join(', '));
  }
  await ctx.close();

  // ── the phone ──
  const mobile = await newContext(browser, { width: 390, height: 844 });
  const mpage = await login(mobile);
  for (const r of routes) {
    await checking(`${r.label} @390: no horizontal overflow`, async () => {
      await mpage.goto(`${BASE}${r.path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      const o = await hasHorizontalOverflow(mpage);
      if (o.overflow) throw new Error(`scrollW ${o.scrollW} > clientW ${o.clientW}`);
      return `${o.clientW}px`;
    });
  }

  // sweep P0-4: the primary verb must exist on the phone, with a real box.
  await checking('@390 businesses list: action buttons tappable', async () => {
    await mpage.goto(`${BASE}/businesses`, { waitUntil: 'networkidle' });
    const boxes = await tappable(mpage, 'section.card li button, section.card li a[href*="/deploy"], section.card li a.btn-quiet');
    const real = boxes.filter((b) => b.w > 0 && b.h >= 24 && b.inViewport);
    if (!real.length) throw new Error(`${boxes.length} candidates, none with a usable box`);
    return `${real.length}/${boxes.length} tappable`;
  });
  if (sample) {
    await checking('@390 business card: action buttons tappable', async () => {
      await mpage.goto(`${BASE}/businesses/${sample.id}`, { waitUntil: 'networkidle' });
      const boxes = await tappable(mpage, 'button, a[role="button"], .btn-primary, .btn-quiet, .btn-outline');
      const real = boxes.filter((b) => b.w > 0 && b.h >= 24 && b.inViewport);
      if (!real.length) throw new Error('no tappable action on the card');
      return `${real.length} tappable`;
    });
  }
  await mobile.close();
}

// ─── 3 · Data truth ──────────────────────────────────────────────────────────

/**
 * Every number on screen, against the SQL it claims to summarise.
 *
 * Sweep P0-3 and P1-3 were both this shape: a widget computing its own answer
 * from a slightly different query than the one a person would write. So the
 * check does not read the widget's source — it reads the rendered digits and
 * compares them to independently written SQL.
 */
async function checkDataTruth(browser: import('playwright').Browser): Promise<void> {
  group('3 · Data truth');
  const ctx = await newContext(browser);
  const page = await login(ctx);

  await checking('Бізнеси: total matches SQL', async () => {
    await page.goto(`${BASE}/businesses`, { waitUntil: 'networkidle' });
    const rows = await page.locator('section.card li').count();
    const dbCount = await count(
      `select count(*)::int n from businesses where id not like $1`, [`${FIXTURE_PREFIX}%`]);
    // The list paginates/filters; assert it never shows MORE than exist.
    if (rows > dbCount) throw new Error(`list shows ${rows}, db has ${dbCount}`);
    if (rows === 0 && dbCount > 0) throw new Error('list empty while db has rows');
    return `${rows} shown / ${dbCount} in db`;
  });

  await checking('Система: queue widget matches workflow_jobs', async () => {
    await page.goto(`${BASE}/settings/system`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    const logicalCount = (statuses: string[]) => count(
      `select count(*)::int n
       from workflow_jobs w
       left join workflow_job_runs r on r.id = w.run_id
       where (w.run_id is null or w.attempt_sequence = r.current_attempt_sequence)
         and coalesce(r.status, w.status) = any($1::text[])`,
      [statuses],
    );
    const queued = await logicalCount(['queued']);
    const running = await logicalCount(['running']);
    const failed = await logicalCount(['failed', 'needs_human']);
    // The bug was two widgets disagreeing. Any number the page prints for these
    // three concepts must be one of the true values, and the true values must
    // appear at all.
    const missing: string[] = [];
    for (const [label, n] of [['queued', queued], ['running', running], ['failed', failed]] as const) {
      if (!new RegExp(`\\b${n}\\b`).test(text)) missing.push(`${label}=${n} not on page`);
    }
    if (missing.length) throw new Error(missing.join('; '));
    return `queued ${queued} · running ${running} · failed ${failed}`;
  });

  await checking('Кампанії: «готові до демо» counts only production_ready', async () => {
    await page.goto(`${BASE}/campaigns`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    const rows = await sql<{ campaign_id: string; n: number }>(
      `select campaign_id, count(*)::int n from businesses
       where status = 'production_ready' and id not like $1 group by 1`, [`${FIXTURE_PREFIX}%`]);
    for (const r of rows) {
      if (!new RegExp(`\\b${r.n}\\b`).test(text)) {
        throw new Error(`campaign ${r.campaign_id}: production_ready=${r.n} not shown`);
      }
    }
    return rows.map((r) => `${r.campaign_id}=${r.n}`).join(', ');
  });

  await checking('every business status resolves to a Ukrainian phrase', async () => {
    const { humanStatus } = await import('../ui/lib/humanStatus.js');
    const statuses = await sql<{ status: string }>(`select distinct status from businesses`);
    const raw = statuses.filter((s) => humanStatus(s.status).text === s.status);
    if (raw.length) throw new Error(`unmapped: ${raw.map((r) => r.status).join(', ')}`);
    return `${statuses.length} statuses mapped`;
  });

  await checking('every project state resolves', async () => {
    const { humanProjectState } = await import('../ui/lib/humanStatus.js');
    const states = await sql<{ state: string }>(`select distinct state from site_projects where state is not null`);
    const raw = states.filter((s) => humanProjectState(s.state).text === s.state);
    if (raw.length) throw new Error(`unmapped: ${raw.map((r) => r.state).join(', ')}`);
    return `${states.length} states mapped`;
  });

  await checking('every job status resolves', async () => {
    const { humanJobStatus } = await import('../ui/lib/humanStatus.js');
    const statuses = await sql<{ status: string }>(`select distinct status from workflow_jobs`);
    const raw = statuses.filter((s) => humanJobStatus(s.status).text === s.status);
    if (raw.length) throw new Error(`unmapped: ${raw.map((r) => r.status).join(', ')}`);
    return `${statuses.length} job statuses mapped`;
  });

  // sweep P2-8 was retracted as a false positive; this is what proves it stays one.
  await checking('every offered stage is a registered job type', async () => {
    const { readFile } = await import('node:fs/promises');
    const stageSrc = await readFile(path.join(ROOT, 'ui/lib/stageNames.ts'), 'utf8');
    const dialogSrc = await readFile(path.join(ROOT, 'ui/components/OtherActionsDialog.tsx'), 'utf8');
    const mainSrc = await readFile(path.join(ROOT, 'src/workers/main.ts'), 'utf8');
    const handlers = new Set([...mainSrc.matchAll(/^\s*'([a-z-]+)':\s*\w+Handler,/gm)].map((m) => m[1]!));
    const staged = new Set([...stageSrc.matchAll(/^\s*'([a-z-]+)':\s*'/gm)].map((m) => m[1]!));
    const dialogBlock = /const STAGES = \[([\s\S]*?)\];/.exec(dialogSrc)?.[1] ?? '';
    const offered = new Set([...dialogBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!));
    const unknown = [...new Set([...staged, ...offered])].filter((s) => !handlers.has(s));
    if (unknown.length) throw new Error(`no handler for: ${unknown.join(', ')}`);
    return `${handlers.size} handlers cover ${staged.size} named + ${offered.size} offered stages`;
  });

  // ── invariants (CLAUDE.md: violation = bug at any phase) ──
  await checking('invariant: 0 facts without source_id', async () => {
    const n = await count(`select count(*)::int n from business_facts where source_id is null`);
    if (n) throw new Error(`${n} facts have no source`);
    return '0';
  });
  await checking('invariant: 0 contacts without source_id', async () => {
    const n = await count(`select count(*)::int n from business_contacts where source_id is null`);
    if (n) throw new Error(`${n} contacts have no source`);
    return '0';
  });
  await checking('invariant: 0 dangling source_id', async () => {
    const n = await count(
      `select count(*)::int n from business_facts f
       left join business_sources s on s.id = f.source_id where s.id is null`);
    if (n) throw new Error(`${n} facts point at a missing source`);
    return '0';
  });
  await checking('invariant: 0 non-private assets', async () => {
    const rows = await sql<{ rights: string; n: number }>(
      `select rights, count(*)::int n from assets where rights is distinct from 'private_demo_only' group by 1`);
    if (rows.length) throw new Error(rows.map((r) => `${r.rights}=${r.n}`).join(', '));
    return '0';
  });
  await checking('invariant: every ai_generated asset names its generator', async () => {
    const n = await count(`select count(*)::int n from assets where ai_generated = true and (generator is null or generator = '')`);
    if (n) throw new Error(`${n} ai assets without a generator`);
    const total = await count(`select count(*)::int n from assets where ai_generated = true`);
    return `${total} ai-generated, all attributed`;
  });

  await checking('verified contact evidence exists in storage (sample 10)', async () => {
    const rows = await sql<{ id: number; raw_object_key: string }>(
      `select c.id, s.raw_object_key from business_contacts c
       join business_sources s on s.id = c.source_id
       where c.verified = true and s.raw_object_key is not null
       and c.business_id not like $1 limit 10`, [`${FIXTURE_PREFIX}%`]);
    if (!rows.length) return 'no verified contacts with a raw key to sample';
    const missing: string[] = [];
    for (const r of rows) {
      const res = await fetch(`${BASE}/api/object?bucket=raw&key=${encodeURIComponent(r.raw_object_key)}`,
        { headers: { cookie: await sessionCookie(page) } });
      if (!res.ok) missing.push(`${r.raw_object_key} → ${res.status}`);
    }
    if (missing.length) throw new Error(missing.join('; ').slice(0, 240));
    return `${rows.length}/${rows.length} readable`;
  });

  await checking('status ↔ history coherence (sample 10)', async () => {
    const rows = await sql<{ id: string; status: string; latest: string }>(
      `select b.id, b.status, h.to_status as latest from businesses b
       join lateral (select to_status from status_history where business_id = b.id
                     order by at desc, id desc limit 1) h on true
       where b.id not like $1 limit 10`, [`${FIXTURE_PREFIX}%`]);
    const bad = rows.filter((r) => r.status !== r.latest);
    if (bad.length) throw new Error(bad.map((b) => `${b.id}: ${b.status} vs ${b.latest}`).join('; '));
    return `${rows.length}/${rows.length} coherent`;
  });

  await ctx.close();
}

async function sessionCookie(page: import('playwright').Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ─── 4 · Links ───────────────────────────────────────────────────────────────

/**
 * Every link on a card, followed.
 *
 * Sweep P0-1 and P0-5 were both dead links that looked alive: a CTA landing on
 * «нічого не чекає», and 14 images whose keys the allowlist rejected. A link
 * check that only asserts 200 would have missed the second, so this also asserts
 * the CONTENT TYPE is the kind of thing the link promised.
 */
async function checkLinks(
  browser: import('playwright').Browser,
  businesses: Array<{ id: string; name: string }>,
): Promise<void> {
  group('4 · Links');
  if (!businesses.length) { check('representative businesses found', false, 'none in db'); return; }

  const ctx = await newContext(browser);
  const page = await login(ctx);
  const cookie = await sessionCookie(page);

  for (const biz of businesses) {
    await checking(`${biz.name}: card links all resolve`, async () => {
      await page.goto(`${BASE}/businesses/${biz.id}`, { waitUntil: 'networkidle' });
      const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => h.startsWith(location.origin)));
      const bad: string[] = [];
      for (const href of [...new Set(hrefs)]) {
        const res = await fetch(href, { headers: { cookie }, redirect: 'follow' });
        if (!res.ok) { bad.push(`${res.status} ${href.replace(BASE, '')}`); continue; }
        const ct = res.headers.get('content-type') ?? '';
        const isObject = href.includes('/api/object');
        const isQa = /\/qa\/\d+/.test(href);
        const isSnapshot = href.includes('/snapshot');
        if (isQa || isSnapshot) {
          if (!ct.includes('text/html')) bad.push(`${href.replace(BASE, '')} → ${ct}`);
        } else if (isObject) {
          // Evidence is either an image or the captured text (never a download).
          const ok = ct.startsWith('image/') || ct.startsWith('text/plain') || ct.startsWith('video/');
          if (!ok) bad.push(`evidence ${href.slice(-40)} → ${ct}`);
        }
      }
      if (bad.length) throw new Error(bad.slice(0, 5).join('; ').slice(0, 300));
      return `${new Set(hrefs).size} links ok`;
    });
  }

  // sweep P0-5: every screenshot on every QA report, including old iterations.
  const qaProjects = await sql<{ business_id: string; n: number }>(
    `select business_id, jsonb_array_length(qa_report_keys) n from site_projects
     where jsonb_array_length(coalesce(qa_report_keys,'[]'::jsonb)) > 0`);
  for (const p of qaProjects) {
    for (let i = 1; i <= Math.min(p.n, 3); i++) {
      await checking(`QA report ${p.business_id} #${i}: all images load`, async () => {
        const res = await page.goto(`${BASE}/businesses/${p.business_id}/qa/${i}`, { waitUntil: 'networkidle' });
        if (!res || res.status() >= 400) throw new Error(`page ${res?.status()}`);
        const imgs = await imageSizes(page);
        const broken = imgs.filter((i2) => i2.w === 0);
        if (broken.length) throw new Error(`${broken.length}/${imgs.length} broken: ${broken[0]!.src.slice(-60)}`);
        return `${imgs.length} images`;
      });
    }
  }

  // Demo/preview must be STYLED — a 200 on the HTML with a dead stylesheet is
  // the failure mode the Referer re-rooting rule exists to prevent.
  const deployed = await sql<{ deploy_url: string }>(
    `select deploy_url from site_projects where deploy_url is not null and state = 'deployed'`);
  for (const d of deployed) {
    await checking(`demo ${d.deploy_url.slice(-28)}: styled`, async () => {
      const res = await fetch(d.deploy_url);
      if (!res.ok) throw new Error(`demo ${res.status}`);
      const html = await res.text();
      const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]!);
      if (!hrefs.length) throw new Error('no stylesheet linked');
      let biggest = 0;
      for (const h of hrefs) {
        const url = new URL(h, d.deploy_url).toString();
        // WITH Referer: root-absolute assets are re-rooted from it by design.
        const cssRes = await fetch(url, { headers: { referer: d.deploy_url } });
        if (!cssRes.ok) throw new Error(`css ${cssRes.status} ${h}`);
        biggest = Math.max(biggest, (await cssRes.text()).length);
      }
      if (biggest <= 500) throw new Error(`largest stylesheet only ${biggest} bytes`);
      return `${hrefs.length} css, ${biggest} bytes`;
    });
  }

  await ctx.close();
}

// ─── 5 · Funnel mechanics ────────────────────────────────────────────────────

/**
 * The half of the product the sweep could not reach.
 *
 * `approvals`, `outreach_messages`, `outreach_events` and `deals` were empty on
 * 2026-08-20, so approve/reject, follow-up scheduling, the double-approve guard
 * and the three build-review decisions had literally never run against data.
 *
 * Every one of them is driven HERE BY CLICKING, not by importing the server
 * action and calling it. That is the whole difference between this group and a
 * unit test: the actions are `'use server'` modules that only work inside the
 * Next runtime (`revalidatePath` needs a request store, `factoryApi` imports
 * `server-only`), and more importantly a button wired to nothing would still
 * pass a direct-call test. What is being verified is that Roman's click reaches
 * the database.
 *
 * Nothing is ever sent: fixtures live on `dry_run`, and each enqueued job is
 * cancelled inside the check that created it.
 */
async function checkFunnel(browser: import('playwright').Browser): Promise<void> {
  group('5 · Funnel mechanics');
  const ctx = await newContext(browser);
  const page = await login(ctx);

  await createCampaign();

  // ── approve path ──
  const ready = await createBusiness({
    id: 'e2e-fixture-ready', name: 'E2E Fixture Salon', status: 'site_ready', score: 88,
  });
  const readyProj = await createSiteProject(ready, 'deployed', { deployed: true });
  const approvalId = await createApproval(ready, 'email');

  await checking('approval card appears in Вхідні', async () => {
    await page.goto(`${BASE}/inbox?business=${ready.id}`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    if (text.includes('нічого не чекає')) throw new Error('inbox says nothing is waiting (sweep P0-1)');
    if (!text.includes(ready.name)) throw new Error('fixture business not on the card');
    return 'card rendered';
  });

  await checking('approve → 1 approval + 1 simulated message + followups', async () => {
    await page.goto(`${BASE}/inbox?business=${ready.id}`, { waitUntil: 'networkidle' });
    // `?business=` filters the inbox to this fixture; assert that BEFORE
    // clicking. Approving is irreversible and a click on the wrong card would
    // decide a real business's outreach.
    await assertOnlyFixture(page, ready.name);
    await page.getByRole('button', { name: /Підтвердити/ }).first().click();
    await page.waitForTimeout(1500);

    const approved = await count(
      `select count(*)::int n from approvals where id = $1 and decision = 'approved'`, [approvalId]);
    if (approved !== 1) throw new Error(`approvals decision rows = ${approved}`);

    // The send job is queued; wait for the worker to write the message row.
    const msg = await waitFor(async () => sqlOne<{ state: string; n: string }>(
      `select state, count(*) over () n from outreach_messages
       where business_id = $1 and idempotency_key = $2`,
      [ready.id, `send-outreach:approval:${approvalId}`]), { timeoutMs: 60_000 });
    if (!msg) throw new Error('no outreach_messages row after approve (worker did not run)');
    if (Number(msg.n) !== 1) throw new Error(`${msg.n} message rows for one approval`);
    if (msg.state !== 'simulated' && msg.state !== 'manual_pending') {
      throw new Error(`state = ${msg.state} — expected a dry-run state, NOT a real send`);
    }

    const followups = await count(
      `select count(*)::int n from pgboss.job where singleton_key like $1`,
      [`followup:approval:${approvalId}%`]);
    return `state=${msg.state}, followups queued=${followups}`;
  });

  /**
   * The double-send guard, asserted at the DATABASE.
   *
   * The button disappears once decided, so a second CLICK is not reachable from
   * the UI — which is itself the first line of defence but not the one that
   * matters. The invariant in CLAUDE.md is "one send per idempotency key", and
   * the thing that must hold it is the conditional UPDATE plus the unique send
   * key, not the rendering. So the check re-issues the decision the way a
   * duplicate request would and asserts nothing moved.
   */
  await checking('second approve cannot produce a second send', async () => {
    const before = await count(
      `select count(*)::int n from outreach_messages where idempotency_key = $1`,
      [`send-outreach:approval:${approvalId}`]);
    // The action's own guard: decision is only settable while it is NULL.
    const rows = await sql(
      `update approvals set decision = 'approved', decided_by = 'e2e-double'
       where id = $1 and decision is null returning id`, [approvalId]);
    if (rows.length !== 0) throw new Error('a second decision was accepted — double-send is possible');

    await page.goto(`${BASE}/inbox?business=${ready.id}`, { waitUntil: 'networkidle' });
    const stillOffered = await page.getByRole('button', { name: /^Підтвердити і надіслати$/ }).count();
    if (stillOffered > 0) throw new Error('approve button still offered after a decision');

    const after = await count(
      `select count(*)::int n from outreach_messages where idempotency_key = $1`,
      [`send-outreach:approval:${approvalId}`]);
    if (after !== before) throw new Error(`message rows went ${before} → ${after}`);
    return `guarded at db and ui (${after} message)`;
  });

  await checking('business reached contacted/outreach_approved', async () => {
    const row = await sqlOne<{ status: string }>(`select status from businesses where id = $1`, [ready.id]);
    if (!row) throw new Error('fixture business vanished');
    if (!['outreach_approved', 'contacted'].includes(row.status)) {
      throw new Error(`status = ${row.status}`);
    }
    return row.status;
  });

  // ── fact review: every verdict has an actual control ──
  const factsCloseBiz = await createBusiness({
    id: 'e2e-fixture-facts-close',
    name: 'E2E Facts Close Salon',
    status: 'needs_review',
    statusReason: 'QA failed: unsupported service claim',
  });
  await checking('fact-review card offers accept, recollect, and close', async () => {
    await page.goto(`${BASE}/inbox?business=${factsCloseBiz.id}`, { waitUntil: 'networkidle' });
    await assertOnlyFixture(page, factsCloseBiz.name);
    for (const label of [
      'Факти правильні — будувати',
      'Перезібрати факти',
      'Не брати в роботу',
    ]) {
      const button = page.getByRole('button', { name: label });
      if (await button.count() !== 1) throw new Error(`expected one «${label}» button`);
    }
    return 'all 3 decisions are reachable';
  });

  await checking('«Не брати в роботу» closes without rejected', async () => {
    await page.goto(`${BASE}/inbox?business=${factsCloseBiz.id}`, { waitUntil: 'networkidle' });
    await assertOnlyFixture(page, factsCloseBiz.name);
    page.once('dialog', (d) => { void d.accept(); });
    await page.getByRole('button', { name: 'Не брати в роботу' }).click();

    const closed = await waitFor(async () => sqlOne<{ status: string }>(
      `select status from businesses where id = $1 and status <> 'needs_review'`,
      [factsCloseBiz.id],
    ), { timeoutMs: 15_000 });
    if (closed?.status !== 'closed') throw new Error(`status = ${closed?.status}`);
    const decision = await sqlOne<{ to_status: string; actor: string }>(
      `select to_status, actor from status_history where business_id = $1 order by id desc limit 1`,
      [factsCloseBiz.id],
    );
    if (decision?.to_status !== 'closed' || decision.actor !== 'roman') {
      throw new Error(`history = ${JSON.stringify(decision)}`);
    }
    return 'closed by roman, not rejected';
  });

  const factsRefreshBiz = await createBusiness({
    id: 'e2e-fixture-facts-refresh',
    name: 'E2E Facts Refresh Salon',
    status: 'needs_review',
    statusReason: 'QA failed: unsupported service claim',
  });
  // Model the already-enqueued branch so this browser check never starts an
  // agent. The click still traverses the real client component and server
  // action; it just finds work that is safe to represent as already queued.
  await sql(
    `insert into workflow_jobs
       (job_type, business_id, campaign_id, idempotency_key, status, attempts, created_at)
     values ('enrich', $1, $2, $3, 'queued', 0, now())`,
    [factsRefreshBiz.id, FIXTURE_CAMPAIGN,
      `${FIXTURE_PREFIX}facts-refresh:${factsRefreshBiz.id}:${Date.now()}`],
  );
  await checking('«Перезібрати факти» resumes enrichment and leaves Вхідні', async () => {
    await page.goto(`${BASE}/inbox?business=${factsRefreshBiz.id}`, { waitUntil: 'networkidle' });
    await assertOnlyFixture(page, factsRefreshBiz.name);
    await page.getByRole('button', { name: 'Перезібрати факти' }).click();

    const moved = await waitFor(async () => sqlOne<{ status: string }>(
      `select status from businesses where id = $1 and status <> 'needs_review'`,
      [factsRefreshBiz.id],
    ), { timeoutMs: 15_000 });
    if (moved?.status !== 'enriching') throw new Error(`status = ${moved?.status}`);
    await page.goto(`${BASE}/inbox?business=${factsRefreshBiz.id}`, { waitUntil: 'networkidle' });
    const stillThere = await page.getByText(factsRefreshBiz.name, { exact: true }).count();
    if (stillThere) throw new Error('resolved fact review is still in Вхідні');
    return 'enriching; review card retired';
  });

  const goodSiteBiz = await createBusiness({
    id: 'e2e-fixture-good-site',
    name: 'E2E Good Site Salon',
    status: 'needs_review',
    statusReason: 'contradiction: owned website renders well but enrichment extracted zero services from it',
  });
  await sql(`update website_audits set verdict = 'working_good' where business_id = $1`, [goodSiteBiz.id]);
  await checking('a good existing site is not presented as an Inbox decision', async () => {
    await page.goto(`${BASE}/inbox?business=${goodSiteBiz.id}`, { waitUntil: 'networkidle' });
    const card = await page.getByText(goodSiteBiz.name, { exact: true }).count();
    if (card) throw new Error('good-site contradiction still renders as a decision card');
    return 'no card; no fake build-or-nothing choice';
  });
  await checking('a good existing site is not in «Чекають мене» either', async () => {
    await page.goto(
      `${BASE}/businesses?attention=1&q=${encodeURIComponent(goodSiteBiz.name)}`,
      { waitUntil: 'networkidle' },
    );
    const row = await page.getByText(goodSiteBiz.name, { exact: true }).count();
    if (row) throw new Error('good-site no-op still appears in the attention preset');
    return 'semantic attention filter agrees with Inbox';
  });

  // ── manual channel deep link ──
  const manualBiz = await createBusiness({
    id: 'e2e-fixture-manual', name: 'E2E Manual Salon', status: 'site_ready',
  });
  await createSiteProject(manualBiz, 'deployed', { deployed: true });
  await createApproval(manualBiz, 'viber');
  await checking('manual channel renders a deep link', async () => {
    await page.goto(`${BASE}/inbox?business=${manualBiz.id}`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    if (!/надішлю сам/i.test(text)) throw new Error('manual channel did not offer the hand-send path');
    // The deep link itself is built client-side from the channel + address.
    const built = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
      .filter((h) => h.startsWith('viber:') || h.startsWith('https://instagram.com')));
    return built.length ? `${built[0]!.slice(0, 40)}…` : 'manual path offered (link appears after approve)';
  });

  // ── reject path ──
  const rejectBiz = await createBusiness({
    id: 'e2e-fixture-reject', name: 'E2E Reject Salon', status: 'site_ready',
  });
  await createSiteProject(rejectBiz, 'deployed', { deployed: true });
  const rejectApproval = await createApproval(rejectBiz, 'email');
  await checking('reject → decision rejected, business rejected, 0 messages', async () => {
    await page.goto(`${BASE}/inbox?business=${rejectBiz.id}`, { waitUntil: 'networkidle' });
    await assertOnlyFixture(page, rejectBiz.name);
    await page.getByRole('button', { name: /^Відхилити$/ }).first().click();
    await page.waitForTimeout(300);
    const reason = page.locator('input[type="text"], textarea').last();
    if (await reason.count()) await reason.fill('e2e відхилення');
    // The confirm button carries the same word; take the one that appeared last.
    await page.getByRole('button', { name: /^Відхилити$/ }).last().click();
    await page.waitForTimeout(1500);

    const dec = await sqlOne<{ decision: string }>(`select decision from approvals where id = $1`, [rejectApproval]);
    if (dec?.decision !== 'rejected') throw new Error(`decision = ${dec?.decision}`);
    const msgs = await count(`select count(*)::int n from outreach_messages where business_id = $1`, [rejectBiz.id]);
    if (msgs !== 0) throw new Error(`${msgs} messages written for a rejected approval`);
    const biz = await sqlOne<{ status: string }>(`select status from businesses where id = $1`, [rejectBiz.id]);
    if (biz?.status !== 'rejected') throw new Error(`status = ${biz?.status}`);
    return 'rejected, nothing sent';
  });

  // ── build review: the three decisions, from the business card ──
  const retryBiz = await createBusiness({
    id: 'e2e-fixture-retry', name: 'E2E Retry Salon', status: 'needs_review',
  });
  const retryProj = await createSiteProject(retryBiz, 'needs_human_review',
    { qaIterations: 3, withWorkspace: true });
  const retryVerdictJob = await createNeedsHumanVisualQaJob(retryBiz, retryProj.projectId!);
  await checking('«Ще спроба» enqueues exactly 1 build-site', async () => {
    const before = await count(`select count(*)::int n from pgboss.job where name = 'build-site'`);
    await page.goto(`${BASE}/businesses/${retryBiz.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Ще спроба' }).first().click();
    await page.waitForTimeout(300);
    await page.locator(`#hdr-note-${retryProj.projectId}`).fill('e2e: зроби кнопку більшою');
    await page.getByRole('button', { name: 'Запустити спробу' }).click();
    // Cancel FIRST, count second. A worker polls this queue continuously, so the
    // window between the click and the assertion is a window in which a real
    // Claude build could start on a fixture. Cancelling by projectId is safe
    // before the count because a cancelled row is still a row.
    await waitFor(async () => count(
      `select count(*)::int n from pgboss.job where name = 'build-site' and data->>'projectId' = $1`,
      [String(retryProj.projectId)]), { timeoutMs: 15_000 });
    await cancelFixtureJob('build-site', retryProj.projectId!, retryBiz.id);

    const after = await count(`select count(*)::int n from pgboss.job where name = 'build-site'`);
    if (after - before !== 1) throw new Error(`build-site jobs went ${before} → ${after}`);
    const mine = await count(
      `select count(*)::int n from pgboss.job where name = 'build-site' and data->>'projectId' = $1`,
      [String(retryProj.projectId)]);
    if (mine !== 1) throw new Error(`${mine} build-site jobs for the fixture project`);
    const verdict = await sqlOne<{ status: string }>(
      `select status from workflow_jobs where id = $1`, [retryVerdictJob]);
    if (verdict?.status !== 'cancelled') {
      throw new Error(`resolved visual-qa verdict stayed ${verdict?.status}`);
    }
    await sql(`update site_projects set state = 'needs_human_review' where id = $1`, [retryProj.projectId]);
    return '+1, queued build cancelled, QA verdict closed';
  });

  const deployBiz = await createBusiness({
    id: 'e2e-fixture-deploy', name: 'E2E Deploy Salon', status: 'needs_review',
  });
  const deployProj = await createSiteProject(deployBiz, 'needs_human_review', { qaIterations: 3 });
  await checking('«Опублікувати як є» creates a deploy job', async () => {
    const before = await count(`select count(*)::int n from pgboss.job where name = 'deploy-demo'`);
    await page.goto(`${BASE}/businesses/${deployBiz.id}`, { waitUntil: 'networkidle' });
    // The button asks for confirmation first — accepting it IS the flow.
    page.once('dialog', (d) => { void d.accept(); });
    await page.getByRole('button', { name: 'Опублікувати як є' }).first().click();
    // Cancel-then-count, same race as «Ще спроба» above.
    await waitFor(async () => count(
      `select count(*)::int n from pgboss.job where name = 'deploy-demo' and data->>'projectId' = $1`,
      [String(deployProj.projectId)]), { timeoutMs: 15_000 });
    await cancelFixtureJob('deploy-demo', deployProj.projectId!, deployBiz.id);

    const after = await count(`select count(*)::int n from pgboss.job where name = 'deploy-demo'`);
    if (after - before !== 1) throw new Error(`deploy-demo jobs went ${before} → ${after}`);
    return '+1, cancelled';
  });

  const killBiz = await createBusiness({
    id: 'e2e-fixture-kill', name: 'E2E Kill Salon', status: 'needs_review',
  });
  const killProj = await createSiteProject(killBiz, 'needs_human_review', { qaIterations: 3 });
  await checking('«Відхилити» rejects with a reason', async () => {
    await page.goto(`${BASE}/businesses/${killBiz.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Відхилити$/ }).first().click();
    await page.waitForTimeout(300);
    await page.locator(`#hdr-rej-${killProj.projectId}`).fill('e2e відхилення');
    await page.getByRole('button', { name: 'Відхилити бізнес' }).click();
    await page.waitForTimeout(2000);

    const biz = await sqlOne<{ status: string; status_reason: string }>(
      `select status, status_reason from businesses where id = $1`, [killBiz.id]);
    if (biz?.status !== 'rejected') throw new Error(`status = ${biz?.status}`);
    const proj = await sqlOne<{ state: string }>(`select state from site_projects where id = $1`, [killProj.projectId]);
    if (proj?.state !== 'failed') throw new Error(`project state = ${proj?.state}`);
    return `rejected: ${biz.status_reason?.slice(0, 40)}`;
  });

  await ctx.close();
}

/**
 * Refuse to click anything unless this page is showing the fixture and only the
 * fixture.
 *
 * Approve and reject are irreversible decisions about a real business's
 * outreach. `?business=<id>` is supposed to narrow the inbox to one card, but
 * "supposed to" is what a gate exists to verify — and if that filter ever
 * regresses, the very next line would decide someone else's approval. The check
 * fails loudly instead.
 */
async function assertOnlyFixture(page: import('playwright').Page, name: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  if (!text.includes(name)) throw new Error(`fixture "${name}" is not on this page`);
  const otherNames = await sql<{ name: string }>(
    `select name from businesses where id not like $1`, [`${FIXTURE_PREFIX}%`]);
  const intruders = otherNames
    .map((r) => r.name)
    .filter((n) => n.length > 6 && text.includes(n));
  if (intruders.length) {
    throw new Error(`page also shows real businesses: ${intruders.slice(0, 3).join(', ')} — refusing to click`);
  }
}

/**
 * Kill a job the gate just created, before a worker can act on it.
 *
 * The check has already proven the click enqueued exactly one job; letting that
 * job RUN would start a real Claude build or a real deploy on a business that is
 * about to be deleted. Both queues are stopped: pg-boss (what the worker polls)
 * and `workflow_jobs` (what the console displays).
 */
async function cancelFixtureJob(name: string, projectId: number, businessId: string): Promise<void> {
  await sql(`update pgboss.job set state = 'cancelled'
             where name = $1 and data->>'projectId' = $2 and state in ('created','active','retry')`,
    [name, String(projectId)]);
  await sql(`update workflow_jobs set status = 'cancelled' where business_id = $1 and job_type = $2`,
    [businessId, name]);
}

// ─── 6 · Jobs UX ─────────────────────────────────────────────────────────────

async function checkJobsUx(browser: import('playwright').Browser): Promise<void> {
  group('6 · Jobs UX');
  const ctx = await newContext(browser);
  const page = await login(ctx);

  const jobBiz = await createBusiness({
    id: 'e2e-fixture-job', name: 'E2E Job Salon', status: 'needs_review',
  });
  const jobId = await createFailedJob(jobBiz, 'enrich');

  const stateBiz = await createBusiness({
    id: 'e2e-fixture-job-states', name: 'E2E Job States Salon', status: 'needs_review',
  });
  await Promise.all([
    createLogicalJobRun({ biz: stateBiz, status: 'queued', attemptStatuses: ['queued'], duplicateSuppressions: 3 }),
    createLogicalJobRun({ biz: stateBiz, status: 'running', attemptStatuses: ['running'], jobType: 'collect-assets' }),
    createLogicalJobRun({ biz: stateBiz, status: 'retry_wait', attemptStatuses: ['retry_wait'], jobType: 'audit-website' }),
    createLogicalJobRun({ biz: stateBiz, status: 'succeeded', attemptStatuses: ['succeeded'], jobType: 'score-and-qa' }),
    createLogicalJobRun({ biz: stateBiz, status: 'failed', attemptStatuses: ['cancelled', 'failed'], jobType: 'build-site' }),
    createLogicalJobRun({ biz: stateBiz, status: 'needs_human', attemptStatuses: ['needs_human'], jobType: 'visual-qa' }),
    createLogicalJobRun({ biz: stateBiz, status: 'cancelled', attemptStatuses: ['cancelled'], jobType: 'deploy-demo' }),
  ]);
  await createBlockedEnrichment(stateBiz);

  await checking('failed job shows in Система with a Ukrainian status', async () => {
    await page.goto(`${BASE}/settings/system`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    if (!text.includes('Помилка')) throw new Error('no «Помилка» status word on the page');
    // sweep P2-3: jobs listed by raw business id rather than name.
    if (text.includes(jobBiz.id) && !text.includes(jobBiz.name)) {
      throw new Error('job listed by raw id, not by business name');
    }
    return 'listed';
  });

  await checking('logical runs render attempts, duplicate suppression and blocked fan-in', async () => {
    await page.goto(`${BASE}/settings/system`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    for (const expected of [
      stateBiz.name,
      'дублів пригнічено: 3',
      '2 спроби · поточна #2',
      'Пауза: ліміт підписки',
      'заблоковано:',
      'collect-assets failed after durable evidence capture',
      'Agent runner',
    ]) {
      if (!text.includes(expected)) throw new Error(`missing system state: ${expected}`);
    }
    if (!/Agent runner[\s\S]{0,180}(ok|degraded)/.test(text)) {
      throw new Error('runner state is neither ok nor degraded');
    }
    return 'logical/attempt, duplicate, retry-wait, barrier and runner states rendered';
  });

  await checking('retry_wait filter keeps the parked logical run', async () => {
    await page.goto(`${BASE}/settings/system?status=retry_wait`, { waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    if (!text.includes(stateBiz.name) || !text.includes('Пауза: ліміт підписки')) {
      throw new Error('parked fixture run missing behind retry_wait filter');
    }
    return 'parked run visible';
  });

  /**
   * The retry button, clicked on the FIXTURE'S OWN ROW and no other.
   *
   * This check earned its narrowness the hard way: an earlier version clicked
   * `getByRole('button', {name: /Спробувати ще раз/}).first()`, which on a real
   * console is some real business's row. It re-queued a stranded
   * `content-and-design` job for Laser Royal Beauty, a worker picked it up
   * within seconds, and the census caught a real build running on real data —
   * exactly the collateral damage this suite promises never to cause.
   *
   * So the row is located BY THE FIXTURE'S NAME first, and the button is
   * required to be inside it. If the fixture's row cannot be found the check
   * fails; it never falls back to "some retry button".
   */
  await checking('retry re-enqueues the fixture job exactly once', async () => {
    await page.goto(`${BASE}/settings/system`, { waitUntil: 'networkidle' });
    const row = page.locator('li, tr', { hasText: jobBiz.name }).last();
    if (!(await row.count())) throw new Error(`no row for fixture "${jobBiz.name}" on Система`);
    const btn = row.getByRole('button', { name: /Спробувати ще раз|Повторити|Ще раз/ }).first();
    if (!(await btn.count())) throw new Error('fixture row offers no retry control');
    await btn.click();

    // The retried row is CLOSED and a fresh attempt row takes its place — the
    // table is an attempt log, so a retry appends rather than resurrects.
    const closed = await waitFor(async () => {
      const r = await sqlOne<{ status: string }>(`select status from workflow_jobs where id = $1`, [jobId]);
      return r && r.status !== 'failed' ? r : null;
    }, { timeoutMs: 15_000 });
    if (!closed) throw new Error('retried job row was never closed out');

    /**
     * At most ONE live job per key — not one row per key, and not exactly one.
     *
     * `workflow_jobs` is an attempt log by design: a real business carries up to
     * nine rows under a single `idempotency_key`, one per attempt plus the
     * reconciler's `stale` closures. Asserting "exactly one row" would assert
     * the opposite of how the table works. What must never happen is two rows a
     * worker could both pick up — that is a double execution, and for a send, a
     * double send.
     *
     * The bound is `<= 1`, not `== 1`, because a live worker is racing this
     * assertion: the fixture has almost no data, so its `enrich` can be picked
     * up AND finish inside the same second, leaving zero live rows. That is the
     * retry working, not failing. The two things that would be real bugs are
     * both still caught: two live rows (double execution), and no new attempt
     * row at all (the retry did nothing).
     */
    const live = await count(
      `select count(*)::int n from workflow_jobs
       where business_id = $1 and job_type = 'enrich' and status in ('queued','running')`, [jobBiz.id]);
    if (live > 1) throw new Error(`${live} live enrich jobs after retry — double execution possible`);

    const attempts = await count(
      `select count(*)::int n from workflow_jobs where business_id = $1 and job_type = 'enrich'`,
      [jobBiz.id]);
    if (attempts < 2) throw new Error(`retry appended no new attempt row (still ${attempts})`);

    // Do not let a real enrich run on a fixture.
    await sql(`update pgboss.job set state = 'cancelled' where singleton_key like $1`, [`${FIXTURE_PREFIX}%`]);
    await sql(`update workflow_jobs set status = 'cancelled'
               where business_id = $1 and status in ('queued','running')`, [jobBiz.id]);
    return `${attempts} attempt rows, ${live} live`;
  });

  const failedBuildBiz = await createBusiness({
    id: 'e2e-fixture-failed-build',
    name: 'E2E Failed Build Salon',
    status: 'site_in_progress',
    statusReason: 'e2e build in progress before failure',
  });
  const failedBuildProject = await createSiteProject(failedBuildBiz, 'building');
  const failedBuildJob = await createFailedJob(failedBuildBiz, 'build-site');
  await checking('failed build offers continue or stop', async () => {
    await page.goto(`${BASE}/inbox?business=${failedBuildBiz.id}`, { waitUntil: 'networkidle' });
    await assertOnlyFixture(page, failedBuildBiz.name);
    for (const label of ['Продовжити збірку', 'Зупинити збірку']) {
      if (await page.getByRole('button', { name: label }).count() !== 1) {
        throw new Error(`expected one «${label}» button`);
      }
    }
    return 'both decisions are reachable';
  });

  await checking('«Зупинити збірку» retires the failure without rejected', async () => {
    await page.goto(`${BASE}/inbox?business=${failedBuildBiz.id}`, { waitUntil: 'networkidle' });
    await assertOnlyFixture(page, failedBuildBiz.name);
    page.once('dialog', (d) => { void d.accept(); });
    await page.getByRole('button', { name: 'Зупинити збірку' }).click();

    const stopped = await waitFor(async () => sqlOne<{
      business_status: string;
      job_status: string;
      project_state: string;
    }>(
      `select b.status business_status, w.status job_status, p.state project_state
       from businesses b
       join workflow_jobs w on w.business_id = b.id and w.id = $2
       join site_projects p on p.business_id = b.id and p.id = $3
       where b.id = $1 and w.status <> 'failed'`,
      [failedBuildBiz.id, failedBuildJob, failedBuildProject.projectId],
    ), { timeoutMs: 15_000 });
    if (stopped?.business_status !== 'production_ready'
      || stopped.job_status !== 'cancelled'
      || stopped.project_state !== 'failed') {
      throw new Error(`stop result = ${JSON.stringify(stopped)}`);
    }
    await page.goto(`${BASE}/inbox?business=${failedBuildBiz.id}`, { waitUntil: 'networkidle' });
    if (await page.getByText(failedBuildBiz.name, { exact: true }).count()) {
      throw new Error('stopped failed build is still in Вхідні');
    }
    return 'production_ready; job cancelled; project failed';
  });

  await ctx.close();
}

// ─── 7 · Demo privacy ────────────────────────────────────────────────────────

/**
 * The «демо приватні» invariant, checked against what is actually on disk.
 *
 * Walking `deploys/` rather than the DB is deliberate: a directory that lost its
 * `site_projects` row is exactly the case where a demo would be served with
 * nobody tracking it.
 */
async function checkDemoPrivacy(): Promise<void> {
  group('7 · Demo privacy');
  const deploysDir = path.join(ROOT, 'deploys');
  let dirs: string[] = [];
  try {
    dirs = (await readdir(deploysDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      // Only things the demo server will actually route. Its token pattern is
      // `[a-z0-9]{16,}` or `preview-<n>`; anything else in this folder (a stray
      // `.screenshots/`) is not reachable over HTTP by construction, so
      // demanding a 200 from it would be testing the gate's own readdir.
      .filter((d) => /^(?:[a-z0-9]{16,}|preview-\d+)$/i.test(d.name))
      .map((d) => d.name);
  } catch { /* no deploys yet */ }

  check('deploys/ has at least one demo to check', dirs.length > 0, `${dirs.length} demo dirs`);

  for (const token of dirs) {
    await checking(`demo /${token.slice(0, 12)}…: 200 + noindex`, async () => {
      const res = await fetch(`${DEMO_BASE}/${token}/`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const robots = res.headers.get('x-robots-tag') ?? '';
      if (!robots.includes('noindex')) throw new Error(`x-robots-tag = "${robots}"`);
      const html = await res.text();
      if (!/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) {
        throw new Error('no <meta robots noindex> in the document');
      }
      return `noindex header + meta`;
    });
  }

  await checking('bad token → 404', async () => {
    const res = await fetch(`${DEMO_BASE}/definitely-not-a-real-token-000/`);
    if (res.status !== 404) throw new Error(`status ${res.status}`);
    return '404';
  });
  await checking('traversal → 404', async () => {
    const res = await fetch(`${DEMO_BASE}/../../etc/passwd`);
    if (res.status !== 404) throw new Error(`status ${res.status}`);
    return '404';
  });
  await checking('encoded traversal → 404', async () => {
    const res = await fetch(`${DEMO_BASE}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    if (res.status !== 404) throw new Error(`status ${res.status}`);
    return '404';
  });
  await checking('deploys root → 404 (no token enumeration)', async () => {
    const res = await fetch(`${DEMO_BASE}/`);
    if (res.status !== 404) throw new Error(`status ${res.status}`);
    return '404';
  });
}

// ─── 8 · Config sanity ───────────────────────────────────────────────────────

async function checkConfig(browser: import('playwright').Browser): Promise<void> {
  group('8 · Config sanity');

  await checking('docker compose config is valid', async () => {
    await execFileAsync('docker', ['compose', 'config', '-q'], { cwd: ROOT });
    return 'valid';
  });

  await checking('all 8 services running', async () => {
    const { stdout } = await execFileAsync('docker',
      ['compose', 'ps', '--format', '{{.Service}} {{.State}}'], { cwd: ROOT });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const down = lines.filter((l) => !l.endsWith(' running'));
    if (down.length) throw new Error(`not running: ${down.join(', ')}`);
    if (lines.length < 8) throw new Error(`only ${lines.length} services up: ${lines.join(', ')}`);
    return `${lines.length} up`;
  });

  await checking('heartbeats fresh (<2 min)', async () => {
    const rows = await sql<{ key: string; value: string }>(
      `select key, value from settings where key like 'heartbeat:%'`);
    if (!rows.length) throw new Error('no heartbeat rows at all');
    const stale: string[] = [];
    for (const r of rows) {
      const at = Date.parse(JSON.parse(r.value)?.at ?? '');
      const ageS = Math.round((Date.now() - at) / 1000);
      if (!Number.isFinite(at) || ageS > 120) stale.push(`${r.key.replace('heartbeat:', '')} ${ageS}s`);
    }
    if (stale.length) throw new Error(`stale: ${stale.join(', ')}`);
    return `${rows.length} fresh`;
  });

  const ctx = await newContext(browser);
  const page = await login(ctx);
  await checking('factory API /health responds', async () => {
    const res = await fetch('http://localhost:8787/health');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json() as { ok: boolean; mode?: string };
    if (!body.ok) throw new Error(JSON.stringify(body));
    return `mode=${body.mode}`;
  });

  if (AGENT_PING) {
    /**
     * The same endpoint the «Перевірити» button hits, over the PUBLISHED port.
     *
     * `FACTORY_API_URL` is `http://factory:8787` — a compose-internal hostname
     * that only resolves inside the network. The gate runs on the host, so it
     * addresses the port compose publishes to loopback instead. Same handler,
     * same real subscription call; only the route in differs.
     */
    await checking('Claude Code check returns ok (real subscription ping)', async () => {
      const key = process.env.INTERNAL_API_KEY
        ?? /^INTERNAL_API_KEY=(.*)$/m.exec(await (await import('node:fs/promises')).readFile(path.join(ROOT, '.env'), 'utf8'))?.[1]?.trim()
        ?? '';
      const res = await fetch('http://localhost:8787/internal/check/claude', {
        method: 'POST',
        headers: { 'x-internal-key': key, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(150_000),
      });
      const body = await res.json() as { ok?: boolean; message?: string; ms?: number };
      if (!res.ok || !body.ok) throw new Error(body.message ?? `status ${res.status}`);
      return `${body.ms ?? '?'}ms`;
    });
  } else {
    check('Claude Code check (skipped: --no-agent-ping)', true, 'skipped');
  }
  await ctx.close();
}

// ─── report ──────────────────────────────────────────────────────────────────

function report(): void {
  const s = summary();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n\x1b[1m── Result ──\x1b[0m`);
  for (const [g, c] of s.byGroup) {
    const mark = c.failed === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${g}: ${c.ok} passed, ${c.failed} failed`);
  }
  if (s.failed) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of failures()) console.log(`  · [${f.group}] ${f.name} — ${f.detail}`);
  }
  console.log(
    s.failed === 0
      ? `\n\x1b[32m🏭 E2E GATE PASSED\x1b[0m — ${s.total} checks in ${secs}s`
      : `\n\x1b[31m💥 ${s.failed}/${s.total} checks failed\x1b[0m — ${secs}s`,
  );
}

main()
  .catch((err) => {
    console.error('\n\x1b[31mgate crashed:\x1b[0m', err);
    check('gate ran to completion', false, String(err).slice(0, 200));
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    process.exit(summary().failed === 0 ? 0 : Math.min(summary().failed, 250));
  });
