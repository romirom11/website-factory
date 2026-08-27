/**
 * Re-runs stage 4+ for specific businesses (or every business whose evidence was
 * produced before a detector fix). Enrichment is idempotent — it clears the
 * business's facts before rewriting them — so this simply re-queues the work.
 *
 * Contacts and playwright-captured sources for the listed businesses are cleared
 * first, because those are the rows a detector bug contaminates. Discovery's
 * gosom evidence is never touched.
 */
import { eq, and, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '../src/db/client.js';
import {
  businessTransitions,
  requireBusinessStatus,
} from '../src/orchestrator/statuses.js';
import { enqueue } from '../src/orchestrator/queue.js';

const args = process.argv.slice(2);
const campaignId = args[0] ?? 'gr-patras-beauty';
const explicit = args.slice(1);

/** Contact values that a platform-chrome bug produces; used to find affected rows. */
const CONTAMINATION = 'treatwell|booksy|fresha|easyrantevou|/recover|/login|instagram\\.com/_|facebook\\.com/v[0-9]|/plugins';

const affected = explicit.length
  ? explicit
  : (await db.execute(sql`
      select distinct c.business_id as id
      from business_contacts c join businesses b on b.id = c.business_id
      where b.campaign_id = ${campaignId} and c.value ~* ${CONTAMINATION}`) as unknown as { rows: { id: string }[] })
      .rows.map((r) => r.id);

if (affected.length === 0) { console.log('nothing to re-enrich'); process.exit(0); }
console.log(`re-enriching ${affected.length} business(es):`);
for (const id of affected) console.log(`  ${id}`);

// Clear only what enrichment rebuilds; keep discovery evidence and the phone
// contact that came from the listing itself.
// ORDER MATTERS: facts and contacts carry a FK to business_sources, so the
// rows that reference a source must go before the source itself.
await db.delete(schema.businessFacts).where(inArray(schema.businessFacts.businessId, affected));
await db.delete(schema.businessContacts).where(inArray(schema.businessContacts.businessId, affected));
await db.delete(schema.businessSources).where(and(
  inArray(schema.businessSources.businessId, affected),
  ne(schema.businessSources.method, 'gosom_api'),
));
await db.delete(schema.assets).where(inArray(schema.assets.businessId, affected));
await db.delete(schema.websiteAudits).where(inArray(schema.websiteAudits.businessId, affected));
await db.delete(schema.productionGaps).where(inArray(schema.productionGaps.businessId, affected));
await db.delete(schema.qualifications).where(and(
  inArray(schema.qualifications.businessId, affected),
  eq(schema.qualifications.stage, 'full'),
));

for (const id of affected) {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, id));
  const [src] = await db.select().from(schema.businessSources).where(and(
    eq(schema.businessSources.businessId, id),
    eq(schema.businessSources.method, 'gosom_api'),
  ));
  if (biz?.phone) {
    await db.insert(schema.businessContacts)
      .values({ businessId: id, channel: 'phone', value: biz.phone, sourceId: src?.id ?? null, verified: true });
  }
  if (!biz) continue;
  const result = await businessTransitions.recover({
    businessId: id,
    expectedStatus: requireBusinessStatus(biz.status, `business ${id}`),
    to: 'prequalified',
    actor: 'phaseB-reenrich',
    reason: 'detector fix: platform-owned contacts',
  });
  if (result.kind === 'conflict') continue;
  await db.update(schema.businesses)
    .set({ score: null, scoreBreakdown: null, updatedAt: new Date() })
    .where(and(eq(schema.businesses.id, id), eq(schema.businesses.status, 'prequalified')));
  await enqueue('enrich', { businessId: id, campaignId });
}
console.log(`\nre-queued ${affected.length} enrich job(s)`);
process.exit(0);
