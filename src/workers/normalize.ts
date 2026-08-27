/**
 * Deterministic normalization + dedup. No LLM here.
 * Dedup order: place_id/listing URL -> normalized phone -> domain -> name+geo.
 * Dedup never deletes evidence: a duplicate attaches its source to the existing business.
 */
import { and, eq, or, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { advance } from '../orchestrator/router.js';
import type { JobPayload } from '../orchestrator/queue.js';
import type { RawCandidate } from './discovery.js';
import { log } from '../lib/logger.js';

export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.length >= 8 ? digits : null;
}

export function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    // booking/directory profiles are NOT owned websites
    const directories = ['facebook.com', 'instagram.com', 'booksy.com', 'fresha.com', 'treatwell.gr', 'linktr.ee', 'business.site'];
    if (directories.some((d) => host.endsWith(d))) return null;
    return host;
  } catch { return null; }
}

export function slugify(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'business';
}

export function normalizeName(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9α-ω]+/g, ' ').trim();
}

function geoClose(aLat: number | null, aLng: number | null, bLat: number | null, bLng: number | null): boolean {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return false;
  const dLat = (aLat - bLat) * 111_000;
  const dLng = (aLng - bLng) * 111_000 * Math.cos((aLat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) < 150; // 150m
}

export async function normalizeHandler(payload: JobPayload): Promise<void> {
  const cand = payload.candidate as unknown as RawCandidate;
  const campaignId = payload.campaignId!;
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign not found: ${campaignId}`);

  const nPhone = normalizePhone(cand.phone);
  const domain = extractDomain(cand.websiteUrl);
  const nName = normalizeName(cand.name);

  // 1) place_id
  let existing = cand.placeId
    ? (await db.select().from(schema.businesses).where(eq(schema.businesses.placeId, cand.placeId)))[0]
    : undefined;
  // 2) phone
  if (!existing && nPhone) {
    existing = (await db.select().from(schema.businesses).where(eq(schema.businesses.normalizedPhone, nPhone)))[0];
  }
  // 3) domain
  if (!existing && domain) {
    existing = (await db.select().from(schema.businesses).where(eq(schema.businesses.domain, domain)))[0];
  }
  // 4) name + geo
  if (!existing) {
    const sameName = await db.select().from(schema.businesses)
      .where(and(eq(schema.businesses.normalizedName, nName), isNotNull(schema.businesses.lat)));
    existing = sameName.find((b) => geoClose(b.lat, b.lng, cand.lat, cand.lng));
  }

  if (existing) {
    await db.insert(schema.businessSources).values({
      businessId: existing.id, sourceType: 'google_maps', url: cand.listingUrl,
      method: 'gosom_api', rawObjectKey: cand.rawObjectKey,
    });
    log.info('duplicate resolved: source attached to existing business', { businessId: existing.id });
    return;
  }

  const id = `${campaign.country}-${slugify(campaign.city)}-${slugify(cand.name)}`;
  // collision on id but not a dedup match -> suffix
  const idTaken = (await db.select().from(schema.businesses).where(eq(schema.businesses.id, id)))[0];
  const businessId = idTaken ? `${id}-${(cand.placeId ?? cand.listingUrl).slice(-6).replace(/[^a-z0-9]/gi, '')}` : id;

  await db.insert(schema.businesses).values({
    id: businessId, campaignId,
    name: cand.name, normalizedName: nName,
    category: cand.category, address: cand.address,
    lat: cand.lat, lng: cand.lng,
    phone: cand.phone, normalizedPhone: nPhone,
    websiteUrl: cand.websiteUrl, domain,
    placeId: cand.placeId, listingUrl: cand.listingUrl,
    rating: cand.rating, reviewCount: cand.reviewCount,
    businessStatus: 'OPERATIONAL', status: 'discovered',
  });
  await db.insert(schema.statusHistory).values({ businessId, toStatus: 'discovered', actor: 'normalize-worker' });
  const [source] = await db.insert(schema.businessSources).values({
    businessId, sourceType: 'google_maps', url: cand.listingUrl,
    method: 'gosom_api', rawObjectKey: cand.rawObjectKey,
  }).returning({ id: schema.businessSources.id });
  if (cand.phone) {
    await db.insert(schema.businessContacts).values({
      businessId, channel: 'phone', value: cand.phone, sourceId: source?.id ?? null, verified: true,
    });
  }
  // gosom's email extraction crawls the business's own website (decision #7)
  if (cand.email) {
    await db.insert(schema.businessContacts).values({
      businessId, channel: 'email', value: cand.email, sourceId: source?.id ?? null, verified: true,
    });
  }
  await advance(businessId); // -> fast-qualify
}
