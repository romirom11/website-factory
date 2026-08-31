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

const ACTIVE_PROJECT_STATES = [
  'pending', 'brief', 'building', 'qa', 'ready', 'needs_human_review',
] as const;
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'retry_wait'] as const;
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
        const matchType = contact.channel === 'email'
          ? 'email'
          : ['phone', 'whatsapp', 'viber'].includes(contact.channel) ? 'phone' : null;
        return matchType
          ? [{ matchType, value: contact.value, reason: `do_not_contact ${businessId}` }]
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

  async startBuild(businessId: string): Promise<StartBuildResult> {
    let result: StartBuildResult = { kind: 'not_found', entity: 'business' };
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [business] = await tx.select().from(schema.businesses)
        .where(eq(schema.businesses.id, businessId))
        .limit(1)
        .for('update');
      if (!business) return [];
      const status = requireBusinessStatus(business.status, `business ${businessId}`);
      if (status !== 'production_ready' && status !== 'needs_review') {
        result = {
          kind: 'state_conflict',
          message: `business status ${status} cannot start a build`,
        };
        return [];
      }

      const [activeProject] = await tx.select({ state: schema.siteProjects.state })
        .from(schema.siteProjects)
        .where(and(
          eq(schema.siteProjects.businessId, businessId),
          inArray(schema.siteProjects.state, ACTIVE_PROJECT_STATES),
        ))
        .orderBy(desc(schema.siteProjects.createdAt))
        .limit(1);
      if (activeProject) {
        result = {
          kind: 'state_conflict',
          message: `site project is already ${activeProject.state}`,
        };
        return [];
      }
      const [activeRun] = await tx.select({ jobType: schema.workflowJobRuns.jobType })
        .from(schema.workflowJobRuns)
        .where(and(
          eq(schema.workflowJobRuns.businessId, businessId),
          inArray(schema.workflowJobRuns.jobType, [
            'content-and-design', 'build-site', 'visual-qa', 'deploy-demo',
          ]),
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
          idempotencyKey: `content-and-design:${businessId}`,
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
