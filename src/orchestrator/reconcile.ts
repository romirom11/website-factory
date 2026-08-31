/**
 * Startup reconciliation: make the DB agree with reality again.
 *
 * `workflow_jobs` is a MIRROR of pg-boss, written by `queue.ts` around the
 * handler. That mirror is only ever advanced by a running handler, so any way a
 * worker process can die without unwinding — SIGKILL, container recreate, an
 * OOM, a crash inside pg-boss itself — leaves a row frozen at `queued` or
 * `running` forever. pg-boss then archives and eventually PURGES its own job,
 * and the mirror row is left pointing at a job that no longer exists anywhere.
 *
 * Observed on 2026-08-20 (audit P0-3): 88 rows — 84 `queued`, 4 `running`,
 * untouched since 2026-08-16 — with ZERO matching rows in `pgboss.job` or
 * `pgboss.archive`. The queue drains new work fine; the backlog was simply
 * never recoverable, and nothing in the product ever said so.
 *
 * The knock-on (audit P0-2) is worse than a wrong number: five businesses sat
 * in `site_in_progress` for 3.5 days with no `site_projects` row and no job,
 * while their card told Roman «Фабрика будує демосайт. Це займає 10–30 хвилин.»
 * A transient status is a CLAIM that something is running. When nothing is,
 * the claim has to be retracted.
 *
 * So this runs once at worker boot, before any handler is registered, and does
 * exactly two things:
 *
 *   1. every mirror row in `queued`/`running` whose pg-boss job is gone,
 *      completed, failed or cancelled becomes `stale`, with the reason on the
 *      row. `stale` is a TERMINAL bookkeeping status: it says "this row is not
 *      the truth about anything", not "this failed" — the work may well have
 *      been done by a later run.
 *   2. every business in a transient status with no live job and no artefact
 *      to show for it is reverted to its last stable status from
 *      `status_history`, actor `reconciler`.
 *
 * What it deliberately does NOT do: re-enqueue. Restarting 84 jobs unattended
 * would burn the subscription window on work Roman may no longer want, and the
 * decision of what to re-run is his — from the card or from Налаштування.
 *
 * That choice is also what makes reconciliation SAFE TO NOTIFY AROUND, which
 * matters more than it looks. Several job types send Telegram on completion
 * (`daily-summary`, and the problem/pause pushes in `queue.ts`), and a
 * reconciler that "recovered" stranded work by re-running it would re-fire
 * every one of those — days-old notifications arriving in a burst on Roman's
 * phone, describing work he already saw. This module imports no notification
 * code at all and only ever writes rows, so a `stale` row is silent by
 * construction: it ends a job's life, it does not restart it.
 *
 * The corollary for anyone adding a re-enqueue here later: use the persisted
 * `workflow_jobs.payload` verbatim. Reconstructing a partial payload from the
 * reporting columns would lose stage-specific fields and suppression flags
 * such as `daily-summary`'s `silent: true`.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db, schema } from '../db/client.js';
import { log } from '../lib/logger.js';
import {
  LegacyJobReconciler,
  type LegacyReconciliationReport,
} from './legacyJobReconciler.js';
import {
  BusinessTransitionService,
  canContinueAfterTransition,
  requireBusinessStatus,
  type BusinessStatus,
} from './statuses.js';

type ReconciliationDatabase = NodePgDatabase<typeof schema>;

/**
 * pg-boss states that still mean "this job will run": anything else (or no row
 * at all, once retention purged it) means the mirror row is lying.
 */
const LIVE_BOSS_STATES = ['created', 'retry', 'active'] as const;

/**
 * Business statuses that promise ongoing work, mapped to the artefact that
 * would prove the work actually landed. A business here with neither a live
 * job nor its artefact is stranded.
 */
const TRANSIENT_STATUSES = ['enriching', 'site_in_progress'] as const;

/**
 * Statuses a stranded business may be reverted TO. `status_history` also holds
 * the transient ones we are reverting from, and re-entering one of those would
 * just recreate the problem one row further back.
 */
const STABLE_STATUSES = [
  'discovered', 'prequalified', 'needs_review', 'qualified',
  'production_ready', 'site_ready', 'rejected', 'duplicate', 'closed', 'do_not_contact',
];

export interface ReconcileReport {
  legacy: LegacyReconciliationReport;
  staleJobs: number;
  revertedBusinesses: Array<{ businessId: string; from: string; to: string }>;
  /** Build projects whose worker died mid-flight; the card now offers a restart. */
  interruptedBuilds: Array<{ businessId: string; projectId: number }>;
}

/**
 * Mirror rows claiming to be live while pg-boss has no live job for them.
 *
 * The check is deliberately by ABSENCE of a live boss row rather than by age:
 * a 40-minute `build-site` session is legitimately `running` and must survive
 * a reconcile that happens to fire next to it, while a 10-second `normalize`
 * whose process died is stale immediately. Rows with `boss_job_id IS NULL`
 * never reached pg-boss at all and are stale by definition.
 *
 * That distinction is load-bearing across CONTAINERS, not just within one.
 * `factory` (core,enrich) and `factory-build` (build) are separate processes
 * with separate lifecycles, so restarting `factory` alone runs this pass while
 * a real 40-minute build is mid-flight in the other container. It survives
 * because pg-boss holds that job in `active` for the duration — the state, not
 * a timer, is what says it is alive. Verified against a live `content-and-design`
 * run on 2026-08-20, and pinned by `scripts/test-reconcile.ts`.
 */
async function markStaleJobs(database: ReconciliationDatabase): Promise<number> {
  const rows = await database.execute(sql`
    with stale as (
      update workflow_jobs w set
        status = 'stale',
        error_code = coalesce(w.error_code, 'STALE'),
        error_detail = coalesce(
          w.error_detail,
          'Робітник перезапустився, поки задача була в черзі — pg-boss її вже не тримає. '
          || 'Задачу не втрачено назавжди: її можна перезапустити вручну.'
        ),
        finished_at = coalesce(w.finished_at, now())
      where w.status in ('queued', 'running', 'retry_wait')
        and (
          w.run_id is null
          or exists (
            select 1 from workflow_job_runs r
            where r.id = w.run_id
              and r.current_attempt_sequence = w.attempt_sequence
              and r.status in ('queued', 'running', 'retry_wait')
          )
        )
        and not exists (
          select 1 from pgboss.job j
          where j.id::text = w.boss_job_id
            and j.state::text in (${sql.join(LIVE_BOSS_STATES.map((s) => sql`${s}`), sql`, `)})
        )
      returning w.id, w.run_id, w.attempt_sequence
    ), closed_runs as (
      update workflow_job_runs r
      set status = 'failed', updated_at = now(), finished_at = coalesce(r.finished_at, now())
      from stale s
      where r.id = s.run_id
        and r.current_attempt_sequence = s.attempt_sequence
        and r.status in ('queued', 'running', 'retry_wait')
      returning r.id
    )
    select id from stale
  `);
  return rows.rows.length;
}

/** The most recent status in `status_history` that is not itself transient. */
async function lastStableStatus(
  database: ReconciliationDatabase,
  businessId: string,
): Promise<BusinessStatus | null> {
  const [row] = await database.select({ to: schema.statusHistory.toStatus })
    .from(schema.statusHistory)
    .where(and(
      eq(schema.statusHistory.businessId, businessId),
      inArray(schema.statusHistory.toStatus, STABLE_STATUSES),
    ))
    .orderBy(desc(schema.statusHistory.at))
    .limit(1);
  return row ? requireBusinessStatus(row.to, `status history for ${businessId}`) : null;
}

/**
 * Businesses whose transient status no longer describes anything happening.
 *
 * Two independent proofs of life are accepted, and only both being absent makes
 * a business stranded:
 *   - a live mirror job of ANY type for it (checked AFTER markStaleJobs, so the
 *     ghosts have already stopped counting as live), or
 *   - for `site_in_progress`, a `site_projects` row: a build that produced a
 *     project is a real build, whatever the job table says, and reverting it
 *     would throw away the operator's view of a real artefact.
 */
async function revertStrandedBusinesses(
  database: ReconciliationDatabase,
): Promise<ReconcileReport['revertedBusinesses']> {
  const transitions = new BusinessTransitionService(database);
  const stranded = await database.execute(sql`
    select b.id, b.status
    from businesses b
    where b.status in (${sql.join(TRANSIENT_STATUSES.map((s) => sql`${s}`), sql`, `)})
      and not exists (
        select 1 from workflow_jobs w
        where w.business_id = b.id
          and w.status in ('queued', 'running', 'retry_wait')
      )
      and not exists (
        select 1 from site_projects p where p.business_id = b.id
      )
  `);

  const out: ReconcileReport['revertedBusinesses'] = [];
  for (const r of stranded.rows as Array<{ id: string; status: string }>) {
    const from = requireBusinessStatus(r.status, `business ${r.id}`);
    // Fall back to `needs_review` rather than guessing: a business with no
    // stable history at all is exactly the case a human should look at, and
    // `needs_review` is the status the inbox already surfaces.
    const to = (await lastStableStatus(database, r.id)) ?? 'needs_review';
    if (to === from) continue;

    const reason = from === 'site_in_progress'
      ? 'Збірку демо перервано перезапуском фабрики: живої задачі й site_project немає. '
        + 'Статус повернуто, демо можна зібрати заново.'
      : 'Збір даних перервано перезапуском фабрики: живої задачі немає. '
        + 'Статус повернуто, крок можна перезапустити.';

    const result = await transitions.recover({
      businessId: r.id,
      expectedStatus: from,
      to,
      reason,
      actor: 'reconciler',
    });
    if (result.kind === 'moved') {
      out.push({ businessId: r.id, from, to });
    } else {
      canContinueAfterTransition(result, { businessId: r.id, actor: 'reconciler' });
    }
  }
  return out;
}

/** Run the repair passes before consumers; any failure aborts worker startup. */
/**
 * Build projects frozen in a transient state with no live build-chain job.
 *
 * A container recreate mid-build leaves `site_projects.state = 'building'`
 * forever: the card then claims «Фабрика будує демосайт», hides the build
 * button, and the live panel shows a frozen log — with no way for Roman to
 * restart (observed on BEAUTIFY Laser, 2026-08-22, after a git-pull redeploy).
 * `failed` is the state the card already knows how to offer a restart for.
 */
async function failInterruptedBuilds(
  database: ReconciliationDatabase,
): Promise<ReconcileReport['interruptedBuilds']> {
  const rows = await database.execute(sql`
    update site_projects p set state = 'failed'
    where p.state in ('pending', 'brief', 'building', 'qa')
      and not exists (
        select 1 from workflow_jobs w
        where w.business_id = p.business_id
          and w.job_type in ('content-and-design', 'build-site', 'visual-qa', 'deploy-demo')
          and w.status in ('queued', 'running', 'retry_wait')
      )
    returning p.id, p.business_id
  `);
  return (rows.rows as Array<{ id: number; business_id: string }>).map((r) => ({
    businessId: r.business_id, projectId: r.id,
  }));
}

/**
 * Build-chain jobs whose worker died WITH this container: put them back in the
 * queue NOW instead of letting them lie for 90 minutes.
 *
 * Called at `factory-build` boot only, for the job types that container owns
 * exclusively. At that moment any mirror row still `running` for those types is
 * dead by definition — its tmux session and agent died with the old container —
 * but pg-boss does not know yet: the boss job sits `active` until its
 * expiration, so for up to 90 minutes the console shows «Виконується» for a
 * process that does not exist. Roman's rule (2026-08-22): «В системі має завжди
 * відображатись поточний реальний стан всього».
 *
 * This is NOT the re-enqueue the module doc above forbids. That rule is about
 * days-old stranded backlog, where restarting is a decision. Here the work was
 * authorized minutes ago, pg-boss is ALREADY going to re-dispatch this exact
 * job at expiration — flipping it to `retry` with `start_after = now()` only
 * removes the artificial wait, and the retry budget is untouched.
 */
export async function requeueOrphanedBuildJobs(
  ownedTypes: readonly string[],
  database: ReconciliationDatabase = db,
): Promise<number> {
  const rows = await database.execute(sql`
    with orphans as (
      select w.id as mirror_id, j.id as boss_id
      from workflow_jobs w
      join pgboss.job j on j.id::text = w.boss_job_id
      where w.status = 'running'
        and j.state = 'active'
        and w.job_type in (${sql.join(ownedTypes.map((t) => sql`${t}`), sql`, `)})
    ),
    bump as (
      update pgboss.job j
      set state = 'retry', start_after = now()
      from orphans o
      where j.id = o.boss_id
      returning j.id
    ),
    requeued as (
      update workflow_jobs w
      set status = 'queued',
          error_detail = 'Збірку перервано перезапуском контейнера — крок одразу повернено в чергу.'
      from orphans o
      where w.id = o.mirror_id
      returning w.id, w.run_id, w.attempt_sequence
    ), reset_runs as (
      update workflow_job_runs r
      set status = 'queued', updated_at = now(), finished_at = null
      from requeued q
      where r.id = q.run_id
        and r.current_attempt_sequence = q.attempt_sequence
        and r.status = 'running'
      returning r.id
    )
    select id from requeued
  `);
  return rows.rows.length;
}

export async function reconcileLegacyJobs(
  database: ReconciliationDatabase = db,
): Promise<LegacyReconciliationReport> {
  return new LegacyJobReconciler(database).reconcile();
}

export async function reconcileOnStartup(
  database: ReconciliationDatabase = db,
  legacy?: LegacyReconciliationReport,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    legacy: legacy ?? await reconcileLegacyJobs(database),
    staleJobs: 0,
    revertedBusinesses: [],
    interruptedBuilds: [],
  };
  try {
    report.staleJobs = await markStaleJobs(database);
    // AFTER markStaleJobs: a ghost job must not count as proof of a live build.
    report.interruptedBuilds = await failInterruptedBuilds(database);
    report.revertedBusinesses = await revertStrandedBusinesses(database);
    if (
      report.legacy.adoptedRuns
      || report.legacy.cancelledDuplicates
      || report.legacy.parkedIncompatible
      || report.staleJobs
      || report.revertedBusinesses.length
    ) {
      log.warn('startup reconciliation closed stranded work', {
        legacy: report.legacy,
        staleJobs: report.staleJobs,
        reverted: report.revertedBusinesses,
      });
    } else {
      log.info('startup reconciliation: nothing stranded');
    }
  } catch (err) {
    log.error('startup reconciliation failed', { err: String(err).slice(0, 500) });
    throw err;
  }
  return report;
}
