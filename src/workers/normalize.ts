/**
 * Deterministic normalization + dedup. No LLM here.
 * Dedup order: place_id/listing URL -> normalized phone -> domain -> name+geo.
 * Dedup never deletes evidence: a duplicate attaches its source to the existing business.
 */
import { pool } from '../db/client.js';
import type { JobPayload } from '../orchestrator/queue.js';
import { getBoss } from '../orchestrator/queue.js';
import type { RawCandidate } from '../discovery/candidate.js';
import { log } from '../lib/logger.js';
import { NormalizationService } from '../orchestrator/normalizationService.js';
import { WorkflowRunStore } from '../orchestrator/workflowRunStore.js';

export {
  extractDomain,
  normalizeName,
  normalizePhone,
  slugify,
} from '../discovery/normalization.js';

export async function normalizeHandler(payload: JobPayload): Promise<void> {
  const cand = payload.candidate as unknown as RawCandidate;
  const campaignId = payload.campaignId!;
  const service = new NormalizationService(new WorkflowRunStore(pool, await getBoss()));
  const result = await service.normalize(campaignId, cand);
  log.info(
    result.kind === 'created'
      ? 'candidate normalized and qualification queued'
      : 'duplicate resolved: source attached to existing business',
    { businessId: result.businessId, qualification: result.job?.kind ?? 'not-required' },
  );
}
