/**
 * Resets phase-B (stages 4-8) output for a campaign so the run can be repeated
 * from a clean state on current code.
 *
 * Deliberately NOT touched:
 *   - businesses rows themselves (phase A discovery output);
 *   - `business_sources` with method='gosom_api' (immutable discovery evidence);
 *   - anything outside the given campaign — the legacy-website-offers rows in
 *     particular are never in scope.
 * Raw objects in storage are immutable and are left alone by design.
 */
import { eq, and, inArray, ne } from 'drizzle-orm';
import { db, schema } from '../src/db/client.js';
import {
  businessTransitions,
  requireBusinessStatus,
} from '../src/orchestrator/statuses.js';

const campaignId = process.argv[2];
if (!campaignId) {
  console.error('usage: pnpm tsx scripts/phaseB-reset.ts <campaignId>');
  process.exit(1);
}

const rows = await db.select({ id: schema.businesses.id, status: schema.businesses.status })
  .from(schema.businesses).where(eq(schema.businesses.campaignId, campaignId));
const ids = rows.map((r) => r.id);
if (ids.length === 0) {
  console.error(`no businesses in campaign ${campaignId}`);
  process.exit(1);
}
console.log(`campaign ${campaignId}: ${ids.length} businesses`);

await db.delete(schema.businessFacts).where(inArray(schema.businessFacts.businessId, ids));
await db.delete(schema.assets).where(inArray(schema.assets.businessId, ids));
await db.delete(schema.websiteAudits).where(inArray(schema.websiteAudits.businessId, ids));
await db.delete(schema.productionGaps).where(inArray(schema.productionGaps.businessId, ids));
await db.delete(schema.qualifications).where(
  and(inArray(schema.qualifications.businessId, ids), eq(schema.qualifications.stage, 'full')),
);
// contacts/sources produced by enrichment; discovery's gosom evidence stays
await db.delete(schema.businessContacts).where(inArray(schema.businessContacts.businessId, ids));
await db.delete(schema.businessSources).where(
  and(inArray(schema.businessSources.businessId, ids), ne(schema.businessSources.method, 'gosom_api')),
);

// Re-seed the phone/email contacts discovery had derived from the listing, so
// stage 3's "has a contact" rule sees the same input it saw in phase A.
let seeded = 0;
for (const id of ids) {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, id));
  const [src] = await db.select().from(schema.businessSources)
    .where(and(eq(schema.businessSources.businessId, id), eq(schema.businessSources.method, 'gosom_api')));
  if (biz?.phone) {
    await db.insert(schema.businessContacts)
      .values({ businessId: id, channel: 'phone', value: biz.phone, sourceId: src?.id ?? null, verified: true });
    seeded++;
  }
}

const reset: string[] = [];
for (const row of rows) {
  const result = await businessTransitions.recover({
    businessId: row.id,
    expectedStatus: requireBusinessStatus(row.status, `business ${row.id}`),
    to: 'prequalified',
    actor: 'phaseB-reset',
    reason: 'clean re-run of stages 4-8',
  });
  if (result.kind === 'conflict') continue;
  await db.update(schema.businesses)
    .set({ score: null, scoreBreakdown: null, updatedAt: new Date() })
    .where(and(eq(schema.businesses.id, row.id), eq(schema.businesses.status, 'prequalified')));
  reset.push(row.id);
}

console.log(`reset ${reset.length} businesses to prequalified; re-seeded ${seeded} phone contacts`);
process.exit(0);
