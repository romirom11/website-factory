import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import {
  businessTransitions,
  type BusinessTransitionResult,
} from './statuses.js';
import { requireBusinessStatus } from './businessStatus.js';

/**
 * Compliance transition with bounded CAS retries.
 *
 * Unlike ordinary stale work, an opt-out must win over a concurrent workflow
 * move. Every retry first observes the new state, so no update is ever made by
 * business id alone and every committed move still has one exact from-state.
 */
export async function enforceDoNotContact(
  businessId: string,
  actor: string,
  reason: string,
): Promise<BusinessTransitionResult> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [business] = await db.select({ status: schema.businesses.status })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId));
    if (!business) throw new Error(`business not found: ${businessId}`);
    const expectedStatus = requireBusinessStatus(business.status, `business ${businessId}`);
    const result = await businessTransitions.override({
      businessId,
      expectedStatus,
      to: 'do_not_contact',
      actor,
      reason,
    });
    if (result.kind !== 'conflict') return result;
  }
  throw new Error(`could not apply do_not_contact after repeated concurrent transitions: ${businessId}`);
}
