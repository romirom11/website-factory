import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import {
  buildJobPriority,
} from './buildPolicy.js';
import {
  BusinessTransitionService,
  requireBusinessStatus,
} from './statuses.js';
import type { EnqueueResult, WorkflowRunStore } from './workflowRunStore.js';
import { normalizeDoNotContactValue } from '../outreach/doNotContact.js';
import { transitionCurrentRun } from './workflowLedger.js';

const ACTIVE_PROJECT_STATES = [
  'pending', 'brief', 'building', 'qa', 'ready', 'needs_human_review',
] as const;
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'retry_wait'] as const;
const BUILD_JOB_TYPES = ['content-and-design', 'build-site', 'visual-qa', 'deploy-demo'] as const;
/** Business statuses a FRESH rebuild may start from: the build flow itself is
 * included because that is where a dead build leaves its business parked. */
const REBUILD_STATUSES = ['production_ready', 'needs_review', 'site_in_progress', 'site_ready'] as const;

export interface StartBuildOptions {
  /**
   * «Побудувати заново»: close whatever is left of the previous build (a
   * project that is failed/cancelled/stuck, the failed or parked jobs that
   * describe it, a business parked in site_in_progress) and start a new
   * project from scratch. Without it, `startBuild` refuses while any of that
   * exists — the behaviour «Побудувати демо» has always had.
   */
  fresh?: boolean;
  /**
   * «Продовжити збірку»: the chain stopped without a successor — a step
   * skipped its verdict as stale, or died with its process — while the project
   * row still says building/qa/ready and nothing will ever move it. Re-enqueue
   * exactly the step that row is waiting for, with the counters it already
   * has; no new design, no new project. Refused while a step is genuinely
   * alive, and when there is no such project (then «Побудувати заново»).
   */
  resume?: boolean;
}
/** Which step a stalled project is waiting for, by its state. */
const RESUME_STEP = { building: 'build-site', qa: 'visual-qa', ready: 'deploy-demo' } as const;
export const DEAL_STATES = ['contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'] as const;
export type DealState = typeof DEAL_STATES[number];

type OperatorDatabase = NodePgDatabase<typeof schema>;

export type OperatorCommandConflict =
  | { kind: 'not_found'; entity: 'business' }
  | { kind: 'state_conflict'; message: string };

export type DoNotContactResult = OperatorCommandConflict | {
  kind: 'blocked';
  businessId: string;
  blockedAddresses: number;
};

export type DealStageResult = OperatorCommandConflict | {
  kind: 'updated';
  businessId: string;
  state: DealState;
};

export type StartBuildResult = OperatorCommandConflict | {
  kind: 'started';
  businessId: string;
  job: EnqueueResult;
};
export type FixPublishedDemoResult = OperatorCommandConflict | {
  kind: 'started';
  businessId: string;
  projectId: number;
  job: EnqueueResult;
};

export type RecollectFactsResult = OperatorCommandConflict
  | { kind: 'already_active'; businessId: string }
  | { kind: 'started'; businessId: string; job: EnqueueResult };

/** Owns operator mutations that must stay consistent with workflow state. */
export class OperatorBusinessCommandService {
  private readonly transitions: BusinessTransitionService;

  constructor(
    private readonly runStore: WorkflowRunStore,
    database: OperatorDatabase,
  ) {
    this.transitions = new BusinessTransitionService(database);
  }

  async markDoNotContact(businessId: string, reason: string): Promise<DoNotContactResult> {
    let result: DoNotContactResult = { kind: 'not_found', entity: 'business' };
    await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) return [];
      const status = requireBusinessStatus(business.status, `business ${businessId}`);
      const contacts = await tx.select({
        channel: schema.businessContacts.channel,
        value: schema.businessContacts.value,
      }).from(schema.businessContacts)
        .where(eq(schema.businessContacts.businessId, businessId));
      const addressRows = contacts.flatMap((contact) => {
        const matchType: 'email' | 'phone' | null = contact.channel === 'email'
          ? 'email'
          : ['phone', 'whatsapp', 'viber'].includes(contact.channel) ? 'phone' : null;
        return matchType
          ? [{
              matchType,
              value: normalizeDoNotContactValue(matchType, contact.value),
              reason: `do_not_contact ${businessId}`,
            }]
          : [];
      });
      await tx.insert(schema.doNotContact).values([
        { matchType: 'business_id', value: businessId, reason },
        ...addressRows,
      ]).onConflictDoNothing();
      const transition = await this.transitions.overrideInTransaction(tx, {
        businessId,
        expectedStatus: status,
        to: 'do_not_contact',
        actor: 'roman',
        reason,
      });
      if (transition.kind === 'conflict') {
        result = {
          kind: 'state_conflict',
          message: `business moved to ${transition.currentStatus}`,
        };
        return [];
      }
      result = { kind: 'blocked', businessId, blockedAddresses: addressRows.length };
      return [];
    });
    return result;
  }

  async updateDealStage(businessId: string, state: DealState): Promise<DealStageResult> {
    let result: DealStageResult = { kind: 'not_found', entity: 'business' };
    await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select({ status: schema.businesses.status })
        .from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) return [];
      const status = requireBusinessStatus(business.status, `business ${businessId}`);
      const transition = await this.transitions.overrideInTransaction(tx, {
        businessId,
        expectedStatus: status,
        to: state,
        actor: 'roman',
        reason: `deal stage -> ${state} (manual)`,
      });
      if (transition.kind === 'conflict') {
        result = {
          kind: 'state_conflict',
          message: `business moved to ${transition.currentStatus}`,
        };
        return [];
      }
      await tx.insert(schema.deals).values({ businessId, state })
        .onConflictDoUpdate({
          target: schema.deals.businessId,
          set: { state, updatedAt: new Date() },
        });
      result = { kind: 'updated', businessId, state };
      return [];
    });
    return result;
  }

  async startBuild(businessId: string, options: StartBuildOptions = {}): Promise<StartBuildResult> {
    const fresh = Boolean(options.fresh);
    const resume = Boolean(options.resume);
    if (fresh && resume) throw new Error('startBuild: fresh and resume are exclusive');
    let result: StartBuildResult = { kind: 'not_found', entity: 'business' };
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select().from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) return [];
      let status = requireBusinessStatus(business.status, `business ${businessId}`);
      const allowedStatuses: readonly string[] = resume
        ? ['site_in_progress']
        : fresh ? REBUILD_STATUSES : ['production_ready', 'needs_review'];
      if (!allowedStatuses.includes(status)) {
        result = {
          kind: 'state_conflict',
          message: `business status ${status} cannot start a build`,
        };
        return [];
      }

      // A build that is genuinely running is never torn down from here: a
      // fresh start is for dead builds, and a live one has «Зупинити».
      const [activeRun] = await tx.select({ jobType: schema.workflowJobRuns.jobType })
        .from(schema.workflowJobRuns)
        .where(and(
          eq(schema.workflowJobRuns.businessId, businessId),
          inArray(schema.workflowJobRuns.jobType, BUILD_JOB_TYPES),
          inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
        ))
        .limit(1);
      if (activeRun) {
        result = {
          kind: 'state_conflict',
          message: `build workflow ${activeRun.jobType} is already active`,
        };
        return [];
      }

      if (resume) {
        const [stalled] = await tx.select({
          id: schema.siteProjects.id,
          state: schema.siteProjects.state,
          qaIterations: schema.siteProjects.qaIterations,
          openIssues: schema.siteProjects.openIssues,
        })
          .from(schema.siteProjects)
          .where(and(
            eq(schema.siteProjects.businessId, businessId),
            inArray(schema.siteProjects.state, Object.keys(RESUME_STEP)),
          ))
          .orderBy(desc(schema.siteProjects.createdAt))
          .limit(1);
        if (!stalled) {
          result = { kind: 'state_conflict', message: 'no stalled site project to resume' };
          return [];
        }
        const step = RESUME_STEP[stalled.state as keyof typeof RESUME_STEP];
        const iteration = stalled.qaIterations ?? 0;
        const base = { businessId, projectId: stalled.id, campaignId: business.campaignId };
        // A resume is a new logical run: the stale key of the lost step must
        // not swallow it as a duplicate.
        const stamp = `resume:${Date.now()}`;
        if (step === 'visual-qa') {
          return [{
            name: 'visual-qa',
            payload: { ...base, iteration, idempotencyKey: `visual-qa:${businessId}:${stalled.id}:${iteration}:${stamp}` },
          }];
        }
        if (step === 'build-site') {
          return [{
            name: 'build-site',
            payload: {
              ...base,
              iteration,
              issues: (stalled.openIssues as string[] | null) ?? [],
              idempotencyKey: `build-site:${businessId}:${stalled.id}:${iteration}:${stamp}`,
            },
          }];
        }
        return [{
          name: 'deploy-demo',
          payload: { ...base, idempotencyKey: `deploy-demo:${businessId}:${stalled.id}:${stamp}` },
        }];
      }

      const [activeProject] = await tx.select({ id: schema.siteProjects.id, state: schema.siteProjects.state })
        .from(schema.siteProjects)
        .where(and(
          eq(schema.siteProjects.businessId, businessId),
          inArray(schema.siteProjects.state, ACTIVE_PROJECT_STATES),
        ))
        .orderBy(desc(schema.siteProjects.createdAt))
        .limit(1);
      if (activeProject && !fresh) {
        result = {
          kind: 'state_conflict',
          message: `site project is already ${activeProject.state}`,
        };
        return [];
      }

      if (fresh) {
        const finishedAt = new Date();
        const reason = 'Роман запустив збірку заново';
        // Whatever the previous build left behind is closed in the same
        // transaction that starts the successor, so the Inbox never shows the
        // old failure next to the new run.
        // A published demo is closed too: the files at its URL stay served
        // until the new build publishes under its own token, so nothing a
        // person may already be looking at goes dark.
        await tx.update(schema.siteProjects)
          .set({ state: 'cancelled' })
          .where(and(
            eq(schema.siteProjects.businessId, businessId),
            inArray(schema.siteProjects.state, [...ACTIVE_PROJECT_STATES, 'deployed']),
          ));
        const closedAttempts = await tx.update(schema.workflowJobs)
          .set({ status: 'cancelled', errorCode: null, errorDetail: reason, finishedAt })
          .where(and(
            eq(schema.workflowJobs.businessId, businessId),
            inArray(schema.workflowJobs.jobType, BUILD_JOB_TYPES),
            inArray(schema.workflowJobs.status, ['failed', 'needs_human']),
          ))
          .returning({
            runId: schema.workflowJobs.runId,
            attemptSequence: schema.workflowJobs.attemptSequence,
          });
        for (const attempt of closedAttempts) {
          await transitionCurrentRun(tx, attempt, ['failed', 'needs_human'], 'cancelled', finishedAt);
        }
        if (status === 'site_in_progress') {
          const recovered = await this.transitions.recoverInTransaction(tx, {
            businessId,
            expectedStatus: 'site_in_progress',
            to: 'production_ready',
            reason,
            actor: 'roman',
          });
          if (recovered.kind !== 'moved') {
            throw new Error(`fresh build lost its locked recovery for ${businessId}`);
          }
          status = 'production_ready';
        } else if (status === 'site_ready') {
          // Backwards on purpose — a published demo is being thrown away — so
          // it is an override under Roman's name, not a normal transition.
          const moved = await this.transitions.overrideInTransaction(tx, {
            businessId,
            expectedStatus: 'site_ready',
            to: 'production_ready',
            actor: 'roman',
            reason,
          });
          if (moved.kind !== 'moved') {
            throw new Error(`fresh build lost its locked override for ${businessId}`);
          }
          status = 'production_ready';
        }
      }

      if (status === 'needs_review') {
        const [gaps] = await tx.select({ count: sql<number>`count(*)` })
          .from(schema.productionGaps)
          .where(and(
            eq(schema.productionGaps.businessId, businessId),
            eq(schema.productionGaps.resolved, false),
            eq(schema.productionGaps.blockerLevel, 'hard'),
          ));
        const openGaps = Number(gaps?.count ?? 0);
        if (openGaps) {
          result = {
            kind: 'state_conflict',
            message: `${openGaps} unresolved hard gaps block the build`,
          };
          return [];
        }
        const transition = await this.transitions.normalInTransaction(tx, {
          businessId,
          expectedStatus: 'needs_review',
          to: 'production_ready',
          actor: 'roman',
          reason: 'manual build start: hard gaps resolved',
        });
        if (transition.kind !== 'moved') {
          throw new Error(`manual build lost its locked transition for ${businessId}`);
        }
      }

      const [audit] = await tx.select({ verdict: schema.websiteAudits.verdict })
        .from(schema.websiteAudits)
        .where(eq(schema.websiteAudits.businessId, businessId))
        .orderBy(desc(schema.websiteAudits.auditedAt))
        .limit(1);
      return [{
        name: 'content-and-design',
        payload: {
          businessId,
          campaignId: business.campaignId,
          // A fresh start is a new logical run by definition; the plain start
          // keeps its stable key so a double click cannot queue twice.
          idempotencyKey: fresh
            ? `content-and-design:${businessId}:rebuild:${Date.now()}`
            : `content-and-design:${businessId}`,
        },
        options: {
          priority: buildJobPriority({ latestVerdict: audit?.verdict, score: business.score }),
        },
      }];
    });
    const job = jobs[0];
    if (job) result = { kind: 'started', businessId, job };
    return result;
  }

  /**
   * «Виправити демо»: a fix round over a PUBLISHED build, with Roman's note as
   * the brief. The demo he saw the bug on stays live at its URL while the
   * builder works; the critic then republishes under the same token (deploy
   * reuses `deploy_token`) or, if it still objects, hands the build back to
   * him. Before this the only way out of «Демо опубліковано» was a full
   * rebuild from the design (2026-09-24).
   *
   * The note itself goes into QA-ISSUES.md through `/internal/qa-note`, which
   * also checks the workspace is still on disk — the caller does that first.
   */
  async fixPublishedDemo(businessId: string, note: string): Promise<FixPublishedDemoResult> {
    const brief = note.trim();
    if (!brief) return { kind: 'state_conflict', message: 'note is required' };
    // `as`, not an annotation: TS narrows a `let` by its initializer and does
    // not see the closure below reassign it, so the `started` check at the end
    // would otherwise be judged impossible.
    let result = { kind: 'not_found', entity: 'business' } as FixPublishedDemoResult;
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select().from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) return [];
      const status = requireBusinessStatus(business.status, `business ${businessId}`);
      if (status !== 'site_ready') {
        result = { kind: 'state_conflict', message: `business status ${status} has no published demo to fix` };
        return [];
      }
      const [activeRun] = await tx.select({ jobType: schema.workflowJobRuns.jobType })
        .from(schema.workflowJobRuns)
        .where(and(
          eq(schema.workflowJobRuns.businessId, businessId),
          inArray(schema.workflowJobRuns.jobType, BUILD_JOB_TYPES),
          inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
        ))
        .limit(1);
      if (activeRun) {
        result = { kind: 'state_conflict', message: `build workflow ${activeRun.jobType} is already active` };
        return [];
      }
      const [project] = await tx.select({
        id: schema.siteProjects.id,
        qaIterations: schema.siteProjects.qaIterations,
      })
        .from(schema.siteProjects)
        .where(and(
          eq(schema.siteProjects.businessId, businessId),
          eq(schema.siteProjects.state, 'deployed'),
        ))
        .orderBy(desc(schema.siteProjects.createdAt))
        .limit(1)
        .for('update');
      if (!project) {
        result = { kind: 'state_conflict', message: 'no published demo to fix' };
        return [];
      }
      await tx.update(schema.siteProjects)
        .set({ state: 'building' })
        .where(eq(schema.siteProjects.id, project.id));
      const moved = await this.transitions.overrideInTransaction(tx, {
        businessId,
        expectedStatus: 'site_ready',
        to: 'site_in_progress',
        actor: 'roman',
        reason: `Роман замовив правку опублікованого демо: ${brief.slice(0, 200)}`,
      });
      if (moved.kind !== 'moved') {
        throw new Error(`demo fix lost its locked override for ${businessId}`);
      }
      // A fix round (iteration ≥ 1) over the existing workspace: the builder
      // reads QA-ISSUES.md with the note on top; the critic, at the cap
      // already, publishes or parks after this one round.
      const iteration = Math.max(1, project.qaIterations ?? 0);
      result = { kind: 'started', businessId, projectId: project.id, job: { kind: 'accepted' } as EnqueueResult };
      return [{
        name: 'build-site',
        payload: {
          businessId,
          projectId: project.id,
          campaignId: business.campaignId,
          iteration,
          issues: [`[high/roman] ${brief}`],
          idempotencyKey: `build-site:${businessId}:${project.id}:roman:${Date.now()}`,
        },
      }];
    });
    const job = jobs[0];
    if (result.kind === 'started') {
      if (!job) throw new Error(`demo fix for ${businessId} committed without its job`);
      return { kind: 'started', businessId: result.businessId, projectId: result.projectId, job };
    }
    return result;
  }

  async recollectFacts(businessId: string): Promise<RecollectFactsResult> {
    let result: RecollectFactsResult = { kind: 'not_found', entity: 'business' };
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select({
        status: schema.businesses.status,
        campaignId: schema.businesses.campaignId,
      }).from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) return [];
      const status = requireBusinessStatus(business.status, `business ${businessId}`);
      if (status !== 'needs_review' && status !== 'enriching') {
        result = {
          kind: 'state_conflict',
          message: `business status ${status} cannot recollect facts`,
        };
        return [];
      }
      const [activeRun] = await tx.select({ id: schema.workflowJobRuns.id })
        .from(schema.workflowJobRuns)
        .where(and(
          eq(schema.workflowJobRuns.businessId, businessId),
          eq(schema.workflowJobRuns.jobType, 'enrich'),
          inArray(schema.workflowJobRuns.status, ACTIVE_RUN_STATUSES),
        ))
        .limit(1);
      if (activeRun) {
        if (status === 'needs_review') {
          const transition = await this.transitions.normalInTransaction(tx, {
            businessId,
            expectedStatus: 'needs_review',
            to: 'enriching',
            actor: 'roman',
            reason: 'manual fact recollection already active',
          });
          if (transition.kind !== 'moved') {
            throw new Error(`fact recollection lost its locked transition for ${businessId}`);
          }
        }
        result = { kind: 'already_active', businessId };
        return [];
      }
      if (status !== 'needs_review') {
        result = {
          kind: 'state_conflict',
          message: 'business is enriching but has no active enrichment run',
        };
        return [];
      }
      const transition = await this.transitions.normalInTransaction(tx, {
        businessId,
        expectedStatus: 'needs_review',
        to: 'enriching',
        actor: 'roman',
        reason: 'manual fact recollection requested',
      });
      if (transition.kind !== 'moved') {
        throw new Error(`fact recollection lost its locked transition for ${businessId}`);
      }
      return [{
        name: 'enrich',
        payload: {
          businessId,
          campaignId: business.campaignId,
          idempotencyKey: `enrich:${businessId}:roman`,
        },
      }];
    });
    const job = jobs[0];
    if (job) result = { kind: 'started', businessId, job };
    return result;
  }
}
