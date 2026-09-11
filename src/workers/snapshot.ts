/**
 * Immutable client snapshot: the ONLY view of a business the builder agent
 * ever sees (spec §4 stage 10). Built exclusively from SOURCED facts, so the
 * builder physically cannot put an unevidenced claim on a demo site.
 */
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

/**
 * Google Maps «About» attributes the builder may put on the page.
 *
 * They are facts (evidence stays), but not every fact is a selling point: a
 * beauty salon's demo rendered a «ΤΟΥΑΛΕΤΑ» chip beside its phone number
 * (BEAUTIFY Laser, 2026-09-11). Restroom-type attributes are dropped from the
 * snapshot in every language gosom returns them in; accessibility, planning and
 * payment attributes stay.
 */
const NON_SITE_AMENITY = /toilet|restroom|bathroom|lavator|\bwc\b|τουαλ|туалет|tuvalet|toilette|baño|servizi igienici/i;
export function isSiteWorthyAmenity(name: string): boolean {
  return !NON_SITE_AMENITY.test(name);
}

export interface ClientSnapshot {
  businessId: string;
  name: string;
  brandName: string | null;
  tagline: string | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  language: string;
  description: string | null;
  about: string[];
  hours: string | null;
  hoursStructured: Record<string, string[]> | null;
  amenities: Array<{ group: string; name: string }>;
  services: Array<{ name: string; price: string | null }>;
  reviews: Array<{ text: string; rating: number | null; author: string | null; theme?: string }>;
  reviewDistribution: Record<string, number> | null;
  socials: Record<string, string>;
  messengers: Array<{ channel: string; value: string }>;
  websiteVerdict: string;
  rating: number | null;
  reviewCount: number | null;
  assets: Array<{ file: string; kind: string; width: number | null; height: number | null; aiGenerated: boolean }>;
  /** Named holes in the evidence, so the builder designs around them honestly. */
  gaps: string[];
}

/** Facts without a source_id never reach the builder (spec §5). */
export async function buildClientSnapshot(businessId: string): Promise<ClientSnapshot> {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, biz.campaignId));
  const allFacts = await db.select().from(schema.businessFacts).where(eq(schema.businessFacts.businessId, businessId));
  const facts = allFacts.filter((f) => f.sourceId !== null);
  const contacts = await db.select().from(schema.businessContacts).where(eq(schema.businessContacts.businessId, businessId));
  const assetRows = await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));
  const gapRows = await db.select().from(schema.productionGaps).where(eq(schema.productionGaps.businessId, businessId));
  const [audit] = await db.select().from(schema.websiteAudits)
    .where(eq(schema.websiteAudits.businessId, businessId))
    .orderBy(desc(schema.websiteAudits.auditedAt)).limit(1);

  const first = <T>(key: string): T | null => {
    const f = facts.find((x) => x.key === key);
    return f ? (f.value as T) : null;
  };
  const all = (key: string) => facts.filter((f) => f.key === key);

  const socials: Record<string, string> = {};
  const messengers: Array<{ channel: string; value: string }> = [];
  for (const c of contacts) {
    if (['instagram', 'facebook', 'tiktok', 'telegram'].includes(c.channel)) socials[c.channel] = c.value;
    if (['whatsapp', 'viber'].includes(c.channel)) messengers.push({ channel: c.channel, value: c.value });
  }

  // Prefer the agent's curated highlights; fall back to raw mined reviews.
  const excerpts = all('review_excerpt').map((f) => {
    const v = f.value as { text: string; rating: number | null; theme?: string };
    return { text: v.text, rating: v.rating ?? null, author: null, theme: v.theme };
  });
  const mined = all('review').map((f) => {
    const v = f.value as { text: string; rating: number | null; author: string | null };
    return { text: v.text, rating: v.rating, author: v.author };
  });

  return {
    businessId,
    name: biz.name,
    brandName: first<string>('identity.brand_name'),
    tagline: first<string>('identity.tagline'),
    category: biz.category,
    address: first<string>('address.confirmed') ?? biz.address,
    phone: biz.phone,
    language: campaign?.language ?? 'en',
    description: first<string>('identity.description') ?? first<string>('google.description'),
    about: all('about').map((f) => String(f.value)),
    hours: first<string>('hours'),
    hoursStructured: first<Record<string, string[]>>('hours.structured'),
    amenities: all('amenity').map((f) => {
      const v = f.value as { group: string; name: string };
      return { group: v.group, name: v.name };
    }).filter((a) => isSiteWorthyAmenity(a.name)),
    services: all('service').map((f) => f.value as { name: string; price: string | null }),
    reviews: excerpts.length ? excerpts : mined,
    reviewDistribution: first<Record<string, number>>('reviews.distribution'),
    socials,
    messengers,
    websiteVerdict: audit?.verdict ?? 'no_website',
    rating: biz.rating,
    reviewCount: biz.reviewCount,
    assets: assetRows.map((a) => ({
      file: `assets/${a.objectKey.split('/').pop()}`,
      kind: a.intendedUsage, width: a.width, height: a.height, aiGenerated: a.aiGenerated,
    })),
    gaps: gapRows.filter((g) => !g.resolved).map((g) => g.gap),
  };
}
