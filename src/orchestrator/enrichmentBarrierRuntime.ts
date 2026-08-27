import { pool } from '../db/client.js';
import {
  EnrichmentBarrier,
  type EnrichmentBranch,
  type EnrichmentBranchAuthorization,
} from './enrichmentBarrier.js';
import { getBoss, NeedsHumanError, type JobPayload } from './queue.js';
import { WorkflowRunStore } from './workflowRunStore.js';

/** Build the barrier against the process's shared DB and pg-boss instances. */
export async function getEnrichmentBarrier(): Promise<EnrichmentBarrier> {
  return new EnrichmentBarrier(new WorkflowRunStore(pool, await getBoss()));
}

export interface PreparedEnrichmentBranch {
  barrier: EnrichmentBarrier;
  runId: string;
  authorization: EnrichmentBranchAuthorization;
}

/** Resolve native or bounded-legacy branch identity before expensive work. */
export async function prepareEnrichmentBranch(
  payload: JobPayload,
  businessId: string,
  branch: EnrichmentBranch,
): Promise<PreparedEnrichmentBranch> {
  const barrier = await getEnrichmentBarrier();
  let runId = typeof payload.enrichmentRunId === 'string'
    ? payload.enrichmentRunId
    : null;
  if (!runId) {
    const adoption = await barrier.adoptLegacyBranch(businessId);
    if (adoption.kind === 'conflict') {
      throw new NeedsHumanError(
        `legacy ${branch} job cannot join native enrichment run ${adoption.runId}`,
      );
    }
    runId = adoption.runId;
    payload.enrichmentRunId = runId;
    payload.enrichmentGeneration = adoption.generation;
  }
  const authorization = await barrier.authorizeBranch({ runId, businessId, branch });
  return { barrier, runId, authorization };
}
