/**
 * Re-enqueues `enrich` for every business of a campaign that has not yet been
 * through stages 4-8. Safe to run repeatedly: the workflow-run unique index
 * returns the canonical active run, and enrichment itself is idempotent (it
 * clears the business's facts before rewriting them).
 */
import { eq, and, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db/client.js';
import { enqueue } from '../src/orchestrator/queue.js';

const campaignId = process.argv[2] ?? 'gr-patras-beauty';
/** Statuses that still need stage 4. */
const PENDING = ['prequalified', 'enriching'];

const rows = await db.select({ id: schema.businesses.id, status: schema.businesses.status })
  .from(schema.businesses)
  .where(and(eq(schema.businesses.campaignId, campaignId), inArray(schema.businesses.status, PENDING)));

console.log(`re-enqueuing enrich for ${rows.length} businesses in ${campaignId}`);
for (const r of rows) {
  const result = await enqueue('enrich', { businessId: r.id, campaignId });
  const outcome = result.kind === 'accepted'
    ? `job ${result.bossJobId}`
    : `already queued as run ${result.runId}`;
  console.log(`  ${r.id} (${r.status}) -> ${outcome}`);
}
process.exit(0);
