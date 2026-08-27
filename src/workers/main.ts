/**
 * Worker registry: binds job types to handlers, in GROUPS.
 *
 * Why groups (SPEC §2.3(а), Roman's decision 2026-08-16): `AGENT_CONCURRENCY` +
 * `withAgentSlot` is a single FIFO queue **per process**. When one process hosts
 * every job type, a 40-minute `build-site` session and a large `enrich` backlog
 * starve each other — observed for real: a build sat 50 minutes behind 126 queued
 * enrich jobs. Splitting job types across processes gives each its own semaphore,
 * which is process topology, not an architectural change.
 *
 *   pnpm workers                      # all groups (single-process dev, default)
 *   pnpm workers --only=core,enrich   # the "factory" container
 *   pnpm workers --only=build         # the "factory-build" container
 *   WORKER_GROUPS=build pnpm workers  # same, via env (docker-compose)
 *
 * Per-group agent concurrency: `AGENT_CONCURRENCY_BUILD` / `AGENT_CONCURRENCY_ENRICH`
 * override `AGENT_CONCURRENCY` when the process runs exactly that group.
 */
import { inArray } from 'drizzle-orm';
import { ensureQueues, register, getBoss, type JobName } from '../orchestrator/queue.js';
import {
  JOB_DEFINITIONS,
  WORKER_GROUP_NAMES,
  type WorkerGroup,
} from '../orchestrator/jobDefinitions.js';
import { reconcileOnStartup, requeueOrphanedBuildJobs } from '../orchestrator/reconcile.js';
import { db, schema } from '../db/client.js';
import { notifyBuildInterrupted } from '../telegram/notify.js';
import { ensureBuckets } from '../lib/storage.js';
import { discoverHandler } from './discovery.js';
import { normalizeHandler } from './normalize.js';
import { fastQualifyHandler } from './fastQualify.js';
import { enrichHandler } from './enrich.js';
import { enrichSocialsHandler } from './enrichSocials.js';
import { collectAssetsHandler } from './assets.js';
import { refreshBrandHandler } from './refreshBrand.js';
import { auditHandler } from './audit.js';
import { scoreAndQaHandler } from './score.js';
import { readinessHandler } from './readiness.js';
import { contentDesignHandler } from './contentDesign.js';
import { buildSiteHandler } from './builder.js';
import { visualQaHandler } from './visualQa.js';
import { deployHandler } from './deploy.js';
import { requestApprovalHandler } from './approval.js';
import { sendOutreachHandler, sendFollowupHandler } from './outreach.js';
import { pollRepliesHandler } from './replies.js';
import { dailySummaryHandler } from './summary.js';
import { setAgentConcurrency } from '../agents/semaphore.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

export type { WorkerGroup } from '../orchestrator/jobDefinitions.js';

/** Logical jobs per process topology, derived from the shared policy registry. */
export const WORKER_GROUPS = Object.fromEntries(
  WORKER_GROUP_NAMES.map((group) => [
    group,
    JOB_DEFINITIONS.filter((definition) => definition.workerGroup === group)
      .map((definition) => definition.name),
  ]),
) as Record<WorkerGroup, JobName[]>;

export const HANDLERS: Record<JobName, Parameters<typeof register>[1]> = {
  'discover': discoverHandler,
  'normalize': normalizeHandler,
  'fast-qualify': fastQualifyHandler,
  'enrich': enrichHandler,
  'enrich-socials': enrichSocialsHandler,
  'collect-assets': collectAssetsHandler,
  'refresh-brand': refreshBrandHandler,
  'audit-website': auditHandler,
  'score-and-qa': scoreAndQaHandler,
  'readiness-gate': readinessHandler,
  'content-and-design': contentDesignHandler,
  'build-site': buildSiteHandler,
  'visual-qa': visualQaHandler,
  'deploy-demo': deployHandler,
  'request-approval': requestApprovalHandler,
  'send-outreach': sendOutreachHandler,
  'send-followup': sendFollowupHandler,
  'poll-replies': pollRepliesHandler,
  'daily-summary': dailySummaryHandler,
};

/** Only the `core` process owns the cron schedules; two would double-fire them. */
const SCHEDULE_GROUP: WorkerGroup = 'core';

/**
 * Groups this process should host. Precedence: explicit argument, then
 * `--only=` on the command line, then `WORKER_GROUPS` env, then all groups.
 */
export function resolveGroups(explicit?: WorkerGroup[]): WorkerGroup[] {
  if (explicit?.length) return explicit;

  const argv = process.argv.slice(2);
  const flag = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
    ?? (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined)
    ?? process.env.WORKER_GROUPS;

  if (!flag || !flag.trim()) return Object.keys(WORKER_GROUPS) as WorkerGroup[];

  const requested = flag.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = requested.filter((g): g is WorkerGroup => g in WORKER_GROUPS);
  const unknown = requested.filter((g) => !(g in WORKER_GROUPS));
  if (unknown.length) {
    throw new Error(
      `unknown worker group(s): ${unknown.join(', ')}. Valid: ${Object.keys(WORKER_GROUPS).join(', ')}`,
    );
  }
  return valid;
}

/**
 * A process hosting exactly one agent-heavy group may use that group's own
 * concurrency. Mixed processes fall back to the global value, because the whole
 * point of the split is that groups no longer share a slot.
 */
function concurrencyFor(groups: WorkerGroup[]): number {
  if (groups.length === 1 && groups[0] === 'build') return config.agents.concurrencyBuild;
  if (groups.length === 1 && groups[0] === 'enrich') return config.agents.concurrencyEnrich;
  return config.agents.concurrency;
}

/**
 * Tell Roman about builds the restart killed.
 *
 * Lives HERE and not in `reconcile.ts` on purpose, and that module's own block
 * comment is the reason: it imports no notification code at all, so that a
 * reconciliation pass can never re-fire days-old pushes in a burst. This is the
 * one notification the pass genuinely warrants, so it is sent by the caller,
 * once, for the projects the pass just failed.
 *
 * One message per build rather than a digest: each one needs a button to its
 * own card, because the answer is always "open it and press Спробувати ще раз".
 * A container recreate touches one or two builds — the build container runs a
 * single agent session at a time — so this is not a burst risk.
 *
 * Never throws: a Telegram outage must not stop the workers from booting.
 */
async function notifyInterruptedBuilds(
  interrupted: Array<{ businessId: string; projectId: number }>,
): Promise<void> {
  if (!interrupted.length) return;
  try {
    const ids = [...new Set(interrupted.map((b) => b.businessId))];
    const rows = await db.select({ id: schema.businesses.id, name: schema.businesses.name })
      .from(schema.businesses)
      .where(inArray(schema.businesses.id, ids));
    const nameById = new Map(rows.map((r) => [r.id, r.name]));

    for (const item of interrupted) {
      await notifyBuildInterrupted({
        businessId: item.businessId,
        name: nameById.get(item.businessId) ?? item.businessId,
      });
    }
  } catch (err) {
    log.warn('failed to notify about interrupted builds', { err: String(err).slice(0, 300) });
  }
}

export async function startWorkers(explicit?: WorkerGroup[]): Promise<void> {
  await ensureBuckets();
  await ensureQueues();

  const groups = resolveGroups(explicit);

  /**
   * Close out work stranded by the previous process BEFORE any handler is
   * registered — otherwise a job picked up in the first second would race the
   * reconciler and could be marked `stale` while it is genuinely running.
   *
   * Only the schedule-owning group does it, for the same reason it owns the
   * schedules: `factory` and `factory-build` boot together, and two concurrent
   * reconcilers would each try to revert the same business. The pass is
   * idempotent anyway, but one writer keeps `status_history` free of duplicate
   * recovery rows.
   */
  if (groups.includes(SCHEDULE_GROUP)) {
    const report = await reconcileOnStartup();
    // A killed build is the one thing the reconciler closes that a person has
    // to act on: the card offers «Спробувати ще раз», but nothing would have
    // told Roman to go and look.
    await notifyInterruptedBuilds(report.interruptedBuilds);
  }

  // The build container resurrects ITS OWN dead: a `running` build job at this
  // process's boot died with the previous container (the tmux session cannot
  // survive a recreate), and pg-boss would only notice at the 90-minute
  // expiration — a «Виконується» that lies for an hour and a half. Requeue them
  // now, BEFORE handlers register, so the first fetch picks the build back up.
  if (groups.includes('build')) {
    const requeued = await requeueOrphanedBuildJobs(WORKER_GROUPS.build);
    if (requeued) {
      log.warn('requeued builds interrupted by the container restart', { requeued });
    }
  }

  const concurrency = concurrencyFor(groups);
  setAgentConcurrency(concurrency);

  const registered: JobName[] = [];
  for (const group of groups) {
    for (const jobName of WORKER_GROUPS[group]) {
      await register(jobName, HANDLERS[jobName]);
      registered.push(jobName);
    }
  }

  if (groups.includes(SCHEDULE_GROUP)) {
    const boss = await getBoss();
    await boss.schedule('poll-replies', '*/10 * * * *', {}, {});
    await boss.schedule('daily-summary', '0 8 * * *', {}, {});
  }

  log.info('workers registered', {
    groups, jobs: registered.length, agentConcurrency: concurrency,
    schedules: groups.includes(SCHEDULE_GROUP),
  });
}

// standalone mode (`pnpm workers`, i.e. the factory-build container)
if (import.meta.url === `file://${process.argv[1]}`) {
  // Settings first: concurrencyFor() below reads them, and a worker started
  // with a cold snapshot would use the .env fallback for a value Roman
  // changed in the UI. Then a 30s heartbeat so the console can see this
  // process is alive (src/lib/settingsStore.ts).
  (async () => {
    const { initSettings, startHeartbeat } = await import('../lib/settingsStore.js');
    await initSettings();
    await startWorkers();
    startHeartbeat(process.env.WORKER_GROUPS ?? 'workers', () => ({
      groups: process.env.WORKER_GROUPS ?? 'all',
    }));
  })().catch((err) => { console.error(err); process.exit(1); });
}
