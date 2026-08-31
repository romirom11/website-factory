import type { EnqueueCommand } from '../orchestrator/workflowRunStore.js';
import { followupIdempotencyKey } from './idempotency.js';

/** Build the canonical delayed jobs used by every initial-send path. */
export function createFollowupCommands(
  approvalId: number,
  businessId: string,
  channel: string,
  days: readonly number[],
): EnqueueCommand[] {
  return days.map((day, index) => ({
    name: 'send-followup',
    payload: {
      businessId,
      followupIndex: index + 1,
      approvalId,
      channel,
      idempotencyKey: followupIdempotencyKey(approvalId, index + 1),
    },
    options: {
      startAfterSeconds: Math.max(0, Math.round(day * 24 * 60 * 60)),
    },
  }));
}
