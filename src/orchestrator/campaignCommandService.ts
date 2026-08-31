import * as schema from '../db/schema.js';
import type { BuildPolicy } from './buildPolicy.js';
import type { EnqueueResult, WorkflowRunStore } from './workflowRunStore.js';

export interface CreateCampaignInput {
  country: string;
  city: string;
  niche: string;
  language: string;
  queries: string[];
  targetCount: number;
  geofence: { lat: number; lng: number; radiusKm: number };
  autoBuild: BuildPolicy;
}

export type CreateCampaignResult =
  | { kind: 'created'; campaignId: string; job: EnqueueResult }
  | { kind: 'exists'; campaignId: string };

function slugPart(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

export function monthlyCampaignId(
  input: Pick<CreateCampaignInput, 'country' | 'city' | 'niche'>,
  now = new Date(),
): string {
  return [input.country, input.city, input.niche, now.toISOString().slice(0, 7)]
    .map(slugPart)
    .filter(Boolean)
    .join('-');
}

/** Atomically create a campaign and its first discovery command. */
export class CampaignCommandService {
  constructor(
    private readonly runStore: WorkflowRunStore,
    private readonly mode: () => 'dry_run' | 'live',
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateCampaignInput): Promise<CreateCampaignResult> {
    const campaignId = monthlyCampaignId(input, this.now());
    let created = false;
    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const rows = await tx.insert(schema.campaigns).values({
        id: campaignId,
        country: input.country,
        city: input.city,
        niche: input.niche,
        language: input.language,
        queries: input.queries,
        geofence: input.geofence,
        targetCount: input.targetCount,
        autoBuild: input.autoBuild,
        mode: this.mode(),
        status: 'running',
      }).onConflictDoNothing().returning({ id: schema.campaigns.id });
      if (!rows.length) return [];
      created = true;
      return [{
        name: 'discover',
        payload: {
          campaignId,
          idempotencyKey: `discover:${campaignId}`,
        },
      }];
    });
    if (!created) return { kind: 'exists', campaignId };
    const job = jobs[0];
    if (!job) throw new Error(`campaign ${campaignId} committed without discovery`);
    return { kind: 'created', campaignId, job };
  }
}
