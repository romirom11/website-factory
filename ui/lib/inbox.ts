/**
 * Everything waiting for Roman, as ONE list.
 *
 * Before this, the four things that need a human lived on four pages: approvals
 * on /approvals, a rejected build only inside a business card (invisible unless
 * you knew to look), broken jobs on /jobs, replies on /conversations. The
 * question "what do I have to do right now?" had no single answer.
 *
 * So the inbox is defined by that question and nothing else: an item is here iff
 * the factory cannot proceed without a decision from Roman. Everything the
 * factory can still do on its own stays out, however interesting it is.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { loadApprovalQueue, type ApprovalItem } from './approvals';
import { queryBusinesses } from './businessQuery';
import { buildButtonState } from './buildPolicy';
import { socialsButtonState } from './socials';
import { cardActionBar, type CardActionBar as ActionBarData } from './cardActions';
import { humanReasonForHeader, reviewAsk } from './humanStatus';

export type InboxKind =
  | 'approval' | 'build_review' | 'business_review' | 'interrupted_build' | 'job' | 'reply';

/**
 * A build the server restart killed, waiting to be started again.
 *
 * Distinct from a `build_review` (the critic looked and refused) and from a
 * `job` failure (a stage errored): nothing here went wrong and nothing was
 * judged — a container recreate took the worker out mid-session, the reconciler
 * failed the orphaned `site_projects` row on the next boot, and the only thing
 * anyone can do about it is press the button again.
 *
 * It gets its own card rather than riding along as a job problem because the
 * job row and the project row disagree by construction in this case: the job is
 * `stale` (bookkeeping, deliberately not "failed") while the project is
 * `failed`, so the job-problem loader never sees it and Roman was left with a
 * card claiming «Фабрика будує демосайт» over a log that had stopped moving.
 */
export interface InterruptedBuildItem {
  projectId: number;
  businessId: string;
  name: string;
  /** When the build was last touched — how long ago it died. */
  at: Date;
  /** Whether restarting is possible right now, and why not when it is not. */
  canRestart: boolean;
  hint: string;
}

export interface BuildReviewItem {
  projectId: number;
  businessId: string;
  name: string;
  campaignId: string;
  score: number | null;
  qaIterations: number;
  openIssues: string[];
  designDirection: string | null;
  /** QA wow score out of 18, when the critic scored it. */
  wowTotal: number | null;
  wowPassed: boolean | null;
  screenshotKeys: string[];
  qaReportKeys: string[];
  updatedAt: Date;
}

export interface JobProblemItem {
  jobId: number;
  jobType: string;
  status: string;
  businessId: string | null;
  businessName: string | null;
  campaignId: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  attempts: number;
  createdAt: Date;
  /** Blocks the business until decided — shown differently and never ages out. */
  actionable: boolean;
}

/**
 * A business the PIPELINE parked in `needs_review` for a verdict — the fourth
 * kind of «Потрібна твоя увага» and the one that used to be invisible here.
 *
 * The build the critic rejected has its card (`build_review`); a dead job has
 * its card; but a business the fact-check refused, or one the qualifier judged
 * «no opportunity», existed only as an amber dot in the /businesses list —
 * Roman had to trawl the list, open each card and hunt the tabs to learn what
 * was being asked (2026-08-23, HUSTLE: «Де тут мені шо робить?»).
 *
 * The item deliberately invents nothing: the row comes from `queryBusinesses`
 * (the same query the /businesses list renders) and the actions come from
 * `cardActionBar` (the ONLY copy of «what can be done with this business»).
 * A business whose bar has nothing pressable — a build already running, a
 * closed status — is not a to-do and never becomes an item.
 */
export interface BusinessReviewItem {
  businessId: string;
  name: string;
  campaignId: string;
  score: number | null;
  status: string;
  /** Header-ready translation of status_reason, or null when it is plumbing. */
  reason: string | null;
  /** What kind of ask this is — decides the card's one-line explanation. */
  ask: 'fact_check' | 'verdict';
  bar: ActionBarData;
  updatedAt: Date;
}

export interface ReplyItem {
  businessId: string;
  name: string;
  dealState: string;
  preview: string;
  at: Date;
}

export interface InboxData {
  approvals: ApprovalItem[];
  buildReviews: BuildReviewItem[];
  businessReviews: BusinessReviewItem[];
  /**
   * `needs_review` businesses whose ask is MATERIALS (readiness gaps) — shown
   * as one aggregate line, not a card each: a fresh campaign parks dozens at
   * once, and thirty near-identical cards is the noise this page removes. The
   * line links to /businesses filtered to exactly these rows.
   */
  materialsWaiting: number;
  /** Individual review items beyond the render cap — also behind the link. */
  businessReviewsMore: number;
  interruptedBuilds: InterruptedBuildItem[];
  jobs: JobProblemItem[];
  replies: ReplyItem[];
  /** Shown in the empty state: proof the factory is working without him. */
  counts: { working: number; demosReady: number; contacted: number };
}

/**
 * Builds the critic rejected after MAX_QA_ITERATIONS.
 *
 * These are the items that were previously invisible: the business goes to
 * `needs_review` and the project to `needs_human_review`, a Telegram push goes
 * out, and then the only way to act on it was to open the business card and read
 * a paragraph. Now it is an item with three buttons.
 */
async function loadBuildReviews(): Promise<BuildReviewItem[]> {
  const projects = await db.select().from(schema.siteProjects)
    .where(eq(schema.siteProjects.state, 'needs_human_review'))
    .orderBy(desc(schema.siteProjects.createdAt));
  if (!projects.length) return [];

  const businesses = await db.select().from(schema.businesses)
    .where(inArray(schema.businesses.id, [...new Set(projects.map((p) => p.businessId))]));
  const bizById = new Map(businesses.map((b) => [b.id, b]));

  // Only the NEWEST rejected project per business: an older one is history, and
  // two cards for one business is exactly the noise this page removes.
  const seen = new Set<string>();
  const items: BuildReviewItem[] = [];
  for (const p of projects) {
    if (seen.has(p.businessId)) continue;
    seen.add(p.businessId);
    const biz = bizById.get(p.businessId);
    if (!biz) continue;
    const qa = p.wowScores?.qa ?? null;
    items.push({
      projectId: p.id,
      businessId: p.businessId,
      name: biz.name,
      campaignId: biz.campaignId,
      score: biz.score,
      qaIterations: p.qaIterations,
      openIssues: (p.openIssues as string[] | null) ?? [],
      designDirection: p.designDirection,
      wowTotal: qa?.total ?? null,
      wowPassed: qa?.passed ?? null,
      screenshotKeys: (p.screenshotKeys as string[] | null) ?? [],
      qaReportKeys: (p.qaReportKeys as string[] | null) ?? [],
      updatedAt: biz.updatedAt,
    });
  }
  return items;
}

/**
 * Builds a restart killed, and whether they can be started again right now.
 *
 * The membership test is a pair of facts, not a guess: the project is `failed`,
 * and its business is still in a status a build can start from. The second half
 * is what keeps this list short — a business Roman has since rejected, or one
 * whose next build already succeeded and moved it to `site_ready`, drops out on
 * its own without anything having to remember to remove it.
 *
 * Only the NEWEST failed project per business, for the same reason
 * `loadBuildReviews` does it: two cards for one business is the noise this page
 * exists to remove.
 *
 * `canRestart` is computed from the same inputs `startDemoBuild` checks, so the
 * card can never offer a button the action would refuse. It deliberately does
 * NOT look at gaps: a build that was already running had passed the readiness
 * gate before the restart, and re-asking is how a recovery becomes a puzzle.
 */
async function loadInterruptedBuilds(): Promise<InterruptedBuildItem[]> {
  const rows = await db.execute(sql`
    select distinct on (p.business_id)
      p.id            as "projectId",
      p.business_id   as "businessId",
      b.name          as "name",
      b.status        as "status",
      p.created_at    as "at",
      exists (
        select 1 from workflow_jobs w
        where w.business_id = p.business_id
          and w.job_type in ('content-and-design', 'build-site', 'visual-qa', 'deploy-demo')
          and w.status in ('queued', 'running', 'retry_wait')
      ) as "busy",
      -- ANY non-failed project supersedes the failure. This was an IN-list of
      -- states and it missed needs_human_review, so the moment a rebuilt demo
      -- reached the critic's verdict, yesterday's killed project popped back up
      -- NEXT TO the review card — «в сенсі перервано? Воно ж дойшло до кінця»
      -- (Roman, 2026-08-22). An allowlist of live states has to be updated every
      -- time one is added; «не failed» is the actual meaning and cannot drift.
      exists (
        select 1 from site_projects q
        where q.business_id = p.business_id
          and q.state <> 'failed'
      ) as "superseded"
    from site_projects p
    join businesses b on b.id = p.business_id
    where p.state = 'failed'
      and b.status in ('production_ready', 'needs_review')
    order by p.business_id, p.created_at desc
  `);

  return (rows.rows as Array<{
    projectId: number; businessId: string; name: string; status: string;
    at: Date | string; busy: boolean; superseded: boolean;
  }>)
    // A newer project that is building/already shipped, or an active replacement
    // job for the failed project, means this failure is history rather than a
    // to-do. In particular, `retry_wait` resumes itself after the subscription
    // window resets; showing a disabled restart card only tells Roman to solve
    // something the factory has already solved.
    .filter((r) => !r.superseded && !r.busy)
    .map((r) => ({
      projectId: r.projectId,
      businessId: r.businessId,
      name: r.name,
      at: r.at instanceof Date ? r.at : new Date(r.at),
      canRestart: true,
      hint: 'Збірка почнеться з нуля; усе зібране про бізнес лишається на місці.',
    }));
}

/**
 * How long an INFORMATIONAL broken job stays in the inbox before it is only
 * history.
 *
 * The window exists because the page would otherwise fill with weeks of
 * failures from stages that have been fixed and re-run since — thirty cards
 * saying "збір даних про бізнес упав" for businesses that finished enrichment
 * days later. That is a log, not a to-do list.
 *
 * But it was applied to EVERYTHING, and that turned ageing into a way for work
 * to leave the to-do list without being done (audit 2026-08-20, P0-1 and P1-6):
 * the `request-approval` failure that blocked the factory's only finished demo
 * became invisible on day four, and the «Вхідні» badge dropped from 2 to 1
 * mid-session with nothing having happened. A to-do list that quietly forgets
 * is worse than a long one.
 *
 * So the window now applies ONLY to jobs whose card is informational — "this
 * stage failed, you may want to retry it". Anything that BLOCKS the pipeline
 * for a business and needs a decision stays until it is decided, however old.
 * See `BLOCKING_JOB_TYPES`.
 */
const JOB_INBOX_WINDOW_MS = 3 * 24 * 3600 * 1000;

/**
 * Job types whose failure stops a business dead and can only be cleared by
 * Roman. These never age out of the inbox.
 *
 * The test is not "how bad was the error" but "can the factory still make
 * progress on this business without him". A failed `enrich` leaves the business
 * where it was and a later re-run fixes it; a failed `request-approval` means a
 * finished, deployed demo has no way to ever be sent, and no amount of waiting
 * changes that.
 */
const BLOCKING_JOB_TYPES: ReadonlySet<string> = new Set([
  // The funnel terminates here: without an approvals row the demo is unsendable.
  'request-approval',
  // A send that broke needs a human by construction — sends are NEVER auto-retried.
  'send-outreach',
  'send-followup',
  // The build path: a business parked in a transient status with a dead build
  // is the "10–30 хвилин" lie the audit found (P0-2). It waits for a decision.
  'content-and-design',
  'build-site',
  'deploy-demo',
]);

/** Does this job need a decision from Roman, rather than just informing him? */
function isActionableJob(jobType: string): boolean {
  return BLOCKING_JOB_TYPES.has(jobType);
}

/**
 * Jobs that stopped, will not restart themselves, and are recent enough to act on.
 *
 * `retry_wait` is deliberately EXCLUDED: a subscription-limit pause resumes on
 * its own (SPEC §2.3b), so putting it in a list titled "waiting for you" would
 * be a lie. It is visible under Налаштування → Система.
 *
 * Two more things are excluded, both for the same reason — they would be a
 * SECOND card about a fact the inbox already shows once:
 *  - a job for a business whose build is already in the list as a build review
 *    (the `visual-qa` job that PARKED that build is exactly that item);
 *  - repeats of the same stage for the same business: one card per business per
 *    stage, the newest, because retrying is per stage and not per attempt.
 */
async function loadJobProblems(excludeBusinessIds: Set<string>): Promise<JobProblemItem[]> {
  const since = new Date(Date.now() - JOB_INBOX_WINDOW_MS);
  // Fetched WITHOUT a date filter, then filtered per type below: an actionable
  // job must be reachable at any age, and only informational ones are windowed.
  const all = await db.select().from(schema.workflowJobs)
    .where(inArray(schema.workflowJobs.status, ['failed', 'needs_human']))
    .orderBy(desc(schema.workflowJobs.createdAt))
    .limit(400);

  // A failure is only a to-do while it is the LAST WORD on that stage for that
  // business. «Повторити» cancels the clicked row and enqueues a fresh one —
  // which lets an OLDER failed row of the same stage resurface as "the newest
  // failed", so Roman saw «Крок упав · спроб: 2» while the retried build was
  // running, pressed «Повторити» again, and re-built a demo that had already
  // succeeded (measured on the server, 2026-08-22: rows failed → cancelled →
  // cancelled → succeeded → running, and the card showed the first one).
  // One query answers it: the newest row per (stage, business) regardless of
  // status; a candidate survives only if that newest row is itself.
  const newest = all.length
    ? (await db.execute(sql`
        select distinct on (job_type, coalesce(business_id, campaign_id, 'global'))
          id, job_type, coalesce(business_id, campaign_id, 'global') as scope
        from workflow_jobs
        order by job_type, coalesce(business_id, campaign_id, 'global'), created_at desc
      `)).rows as Array<{ id: number; job_type: string; scope: string }>
    : [];
  const newestIdByKey = new Map(newest.map((r) => [`${r.job_type}:${r.scope}`, Number(r.id)]));

  const seen = new Set<string>();
  const jobs = all.filter((j) => {
    // NEEDS_HUMAN from visual QA is represented only by BuildReviewCard while
    // its project waits in `needs_human_review`. After SHIP / ITERATE / DROP the
    // project advances, so this row is resolved history — never a retryable job.
    // Keeping it here produced the fake «чекає рішення» card from the screenshot.
    if (j.jobType === 'visual-qa' && j.status === 'needs_human') return false;
    if (!isActionableJob(j.jobType) && j.createdAt < since) return false;
    if (j.businessId && excludeBusinessIds.has(j.businessId)) return false;
    const key = `${j.jobType}:${j.businessId ?? j.campaignId ?? 'global'}`;
    if (newestIdByKey.get(key) !== j.id) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
    // Actionable first, so an old blocking failure is never pushed off the end
    // of the list by a fresh informational one.
    .sort((a, b) => Number(isActionableJob(b.jobType)) - Number(isActionableJob(a.jobType)))
    .slice(0, 20);
  if (!jobs.length) return [];

  const ids = [...new Set(jobs.map((j) => j.businessId).filter((x): x is string => Boolean(x)))];
  const businesses = ids.length
    ? await db.select({ id: schema.businesses.id, name: schema.businesses.name })
        .from(schema.businesses).where(inArray(schema.businesses.id, ids))
    : [];
  const nameById = new Map(businesses.map((b) => [b.id, b.name]));

  return jobs.map((j) => ({
    jobId: j.id,
    jobType: j.jobType,
    status: j.status,
    businessId: j.businessId,
    businessName: j.businessId ? nameById.get(j.businessId) ?? null : null,
    campaignId: j.campaignId,
    errorCode: j.errorCode,
    errorDetail: j.errorDetail,
    attempts: j.attempts,
    createdAt: j.createdAt,
    actionable: isActionableJob(j.jobType),
  }));
}

/** Render cap for individual business-review cards; the rest go behind the link. */
const BUSINESS_REVIEW_CAP = 12;

/**
 * Businesses the pipeline parked for a verdict — see `BusinessReviewItem`.
 *
 * Everything here is derived, not invented: rows via `queryBusinesses`,
 * actions via `cardActionBar`, the ask via `reviewAsk` — the same three
 * modules the /businesses list and the business card already use, so the
 * inbox can never disagree with them about what a business needs.
 */
async function loadBusinessReviews(excludeBusinessIds: Set<string>): Promise<{
  items: BusinessReviewItem[];
  materialsWaiting: number;
  more: number;
}> {
  const rows = await queryBusinesses({
    campaign: null, statuses: ['needs_review'], attention: false, verdicts: [], contacts: [],
    minScore: null, q: null, sort: 'updated_at', dir: 'desc',
  }, 300);

  let materialsWaiting = 0;
  const candidates: BusinessReviewItem[] = [];
  for (const r of rows) {
    if (excludeBusinessIds.has(r.id)) continue;

    const ask = reviewAsk(r.statusReason, r.verdict);
    if (ask === 'materials') {
      materialsWaiting += 1;
      continue;
    }
    // A confident "their current site is already good" verdict is a completed
    // machine decision, not a task for Roman. Keep the verdict and evidence on
    // the business, including the rare manual build override, but do not turn
    // every sensible no-op into inbox work.
    if (ask === 'no_action') continue;

    const build = buildButtonState({
      status: r.status,
      openGaps: r.openGaps,
      activeProjectState: r.projectState,
      activeJobStatus: r.buildJobStatus,
      statusReason: r.statusReason,
      verdict: r.verdict,
      hasEvidence: r.hasEvidence,
    });
    const socials = socialsButtonState({
      verifiedPlatforms: r.verifiedSocials,
      activeJobStatus: r.socialsJobStatus,
      status: r.status,
    });
    const bar = cardActionBar({
      businessId: r.id,
      status: r.status,
      projectState: r.projectState,
      projectId: null,
      deployUrl: r.deployUrl,
      build,
      socials,
      openGaps: r.openGaps,
      socialsGap: r.openGaps.includes('socials_unresolved'),
      hasPendingApproval: false,
      statusReason: r.statusReason,
      buildJobStatus: r.buildJobStatus,
    });

    // Nothing pressable means nothing is being asked RIGHT NOW: a rebuild is
    // already running, or the row is mid-flight. The status badge may lag the
    // pipeline; the bar never does — so the bar decides membership.
    if (!bar.decision && bar.actions.length === 0) continue;

    candidates.push({
      businessId: r.id,
      name: r.name,
      campaignId: r.campaignId,
      score: r.score,
      status: r.status,
      reason: humanReasonForHeader(r.statusReason),
      ask,
      bar,
      updatedAt: r.updatedAt,
    });
  }

  return {
    items: candidates.slice(0, BUSINESS_REVIEW_CAP),
    materialsWaiting,
    more: Math.max(0, candidates.length - BUSINESS_REVIEW_CAP),
  };
}

/** Businesses that answered. The only inbound item, and the most valuable one. */
async function loadReplies(): Promise<ReplyItem[]> {
  const events = await db.select().from(schema.outreachEvents)
    .where(eq(schema.outreachEvents.event, 'replied'))
    .orderBy(desc(schema.outreachEvents.at))
    .limit(30);
  if (!events.length) return [];

  const ids = [...new Set(events.map((e) => e.businessId))];
  const businesses = await db.select().from(schema.businesses)
    .where(inArray(schema.businesses.id, ids));
  const bizById = new Map(businesses.map((b) => [b.id, b]));
  const deals = await db.select().from(schema.deals)
    .where(inArray(schema.deals.businessId, ids));
  const dealByBiz = new Map(deals.map((d) => [d.businessId, d]));

  // A reply stops being an inbox item once the deal has moved past `replied` —
  // Roman has already acted on it.
  const seen = new Set<string>();
  const items: ReplyItem[] = [];
  for (const e of events) {
    if (seen.has(e.businessId)) continue;
    seen.add(e.businessId);
    const biz = bizById.get(e.businessId);
    if (!biz) continue;
    const deal = dealByBiz.get(e.businessId);
    if (deal && !['contacted', 'replied'].includes(deal.state)) continue;
    items.push({
      businessId: e.businessId,
      name: biz.name,
      dealState: deal?.state ?? 'replied',
      preview: String((e.detail as Record<string, unknown> | null)?.preview ?? '').slice(0, 240),
      at: e.at,
    });
  }
  return items;
}

/** The three numbers the empty state shows: proof the factory is still running. */
async function loadCounts(): Promise<InboxData['counts']> {
  const rows = await db.execute(sql`
    select
      count(*) filter (where status in
        ('enriching','qualified','production_ready','site_in_progress'))::int as working,
      count(*) filter (where status = 'site_ready')::int as "demosReady",
      count(*) filter (where status in ('contacted','replied','meeting','proposal','won'))::int as contacted
    from businesses
  `);
  const r = (rows.rows[0] ?? {}) as Record<string, number>;
  return {
    working: Number(r.working ?? 0),
    demosReady: Number(r.demosReady ?? 0),
    contacted: Number(r.contacted ?? 0),
  };
}

export async function loadInbox(): Promise<InboxData> {
  const [approvals, buildReviews, interruptedBuilds, replies, counts] = await Promise.all([
    loadApprovalQueue(),
    loadBuildReviews(),
    loadInterruptedBuilds(),
    loadReplies(),
    loadCounts(),
  ]);
  // A build waiting for a decision already explains itself; the job that parked
  // it must not become a second card saying the same thing in worse words.
  //
  // The same now applies to approvals. Removing the inbox window for actionable
  // jobs (see JOB_INBOX_WINDOW_MS) means a `request-approval` that failed once
  // stays visible forever — correct while it is still blocking, but once the
  // stage has been re-run and the approval row EXISTS, the old failure is
  // history and the decision is the card. Without this, Pagoulatos showed both
  // its approval card and the 2026-08-16 «Крок зупинився» card for the very
  // job that has since succeeded.
  //
  // Interrupted builds are covered for the same reason: the `content-and-design`
  // or `build-site` job that died with the container is in the job table too,
  // and rendering both would give one killed build two cards — one saying
  // «Крок упав», one saying «Збірку перервано» — for a single event.
  const covered = new Set([
    ...buildReviews.map((b) => b.businessId),
    ...approvals.map((a) => a.businessId),
    ...interruptedBuilds.map((b) => b.businessId),
  ]);
  const jobs = await loadJobProblems(covered);
  // Business reviews come LAST in the dedup chain: any richer card about the
  // same business (a rejected build, a broken job, an approval) already says
  // more than «пайплайн чекає вердикту», so this one yields to all of them.
  const businessReviews = await loadBusinessReviews(new Set([
    ...covered,
    ...jobs.map((j) => j.businessId).filter((x): x is string => Boolean(x)),
  ]));
  return {
    approvals, buildReviews,
    businessReviews: businessReviews.items,
    materialsWaiting: businessReviews.materialsWaiting,
    businessReviewsMore: businessReviews.more,
    interruptedBuilds, jobs, replies, counts,
  };
}

/** How many items are waiting overall — the number next to «Вхідні» in the nav. */
export async function inboxCount(): Promise<number> {
  try {
    // Counted the same way the page filters, or the badge promises work that
    // is not there — the fastest way to make Roman stop trusting the number.
    const {
      approvals, buildReviews, businessReviews, businessReviewsMore,
      materialsWaiting, interruptedBuilds, jobs, replies,
    } = await loadInbox();
    return approvals.length + buildReviews.length
      + businessReviews.length + businessReviewsMore
      // The materials pile counts as ONE decision («йди розбери список»), not N.
      + (materialsWaiting > 0 ? 1 : 0)
      + interruptedBuilds.length + jobs.length + replies.length;
  } catch {
    return 0;
  }
}
