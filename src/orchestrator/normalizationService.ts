import { createHash } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { RawCandidate } from '../discovery/candidate.js';
import {
  extractDomain,
  geoClose,
  normalizeName,
  normalizePhone,
  slugify,
} from '../discovery/normalization.js';
import * as schema from '../db/schema.js';
import {
  type EnqueueResult,
  type WorkflowRunStore,
  type WorkflowRunTransaction,
} from './workflowRunStore.js';

export type NormalizeCandidateResult = {
  kind: 'created' | 'duplicate';
  businessId: string;
  job: EnqueueResult | null;
};

function identityLocks(
  candidate: RawCandidate,
  normalizedPhone: string | null,
  domain: string | null,
  normalizedName: string,
  baseId: string,
): string[] {
  const geo = candidate.lat == null || candidate.lng == null
    ? null
    : `${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}`;
  return [
    candidate.placeId ? `place:${candidate.placeId}` : null,
    normalizedPhone ? `phone:${normalizedPhone}` : null,
    domain ? `domain:${domain}` : null,
    geo ? `name-geo:${normalizedName}:${geo}` : null,
    `business-id:${baseId}`,
  ].filter((value): value is string => Boolean(value)).sort();
}

async function lockCandidateIdentities(
  tx: WorkflowRunTransaction,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`normalize:${key}`}, 0))`);
  }
}

async function attachSource(
  tx: WorkflowRunTransaction,
  businessId: string,
  candidate: RawCandidate,
): Promise<number> {
  const [existing] = await tx.select({ id: schema.businessSources.id })
    .from(schema.businessSources)
    .where(and(
      eq(schema.businessSources.businessId, businessId),
      eq(schema.businessSources.url, candidate.listingUrl),
      eq(schema.businessSources.method, 'gosom_api'),
    ))
    .limit(1);
  if (existing) return existing.id;
  const [source] = await tx.insert(schema.businessSources).values({
    businessId,
    sourceType: 'google_maps',
    url: candidate.listingUrl,
    method: 'gosom_api',
    rawObjectKey: candidate.rawObjectKey,
  }).returning({ id: schema.businessSources.id });
  if (!source) throw new Error(`failed to attach discovery source to ${businessId}`);
  return source.id;
}

function collisionSuffix(candidate: RawCandidate): string {
  return createHash('sha256')
    .update(candidate.placeId ?? candidate.listingUrl)
    .digest('hex')
    .slice(0, 10);
}

/** Owns candidate dedup, evidence creation, and the first stage handoff. */
export class NormalizationService {
  constructor(private readonly runStore: WorkflowRunStore) {}

  async normalize(campaignId: string, candidate: RawCandidate): Promise<NormalizeCandidateResult> {
    const normalizedPhone = normalizePhone(candidate.phone);
    const domain = extractDomain(candidate.websiteUrl);
    const normalizedName = normalizeName(candidate.name);
    let result: Omit<NormalizeCandidateResult, 'job'> | null = null;
    let shouldQualify = false;

    const jobs = await this.runStore.enqueueTransaction(async (tx) => {
      const [campaign] = await tx.select().from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId))
        .limit(1);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);

      const baseId = `${campaign.country}-${slugify(campaign.city)}-${slugify(candidate.name)}`;
      await lockCandidateIdentities(
        tx,
        identityLocks(candidate, normalizedPhone, domain, normalizedName, baseId),
      );

      let existing = candidate.placeId
        ? (await tx.select().from(schema.businesses)
            .where(eq(schema.businesses.placeId, candidate.placeId)).limit(1))[0]
        : undefined;
      if (!existing && normalizedPhone) {
        [existing] = await tx.select().from(schema.businesses)
          .where(eq(schema.businesses.normalizedPhone, normalizedPhone)).limit(1);
      }
      if (!existing && domain) {
        [existing] = await tx.select().from(schema.businesses)
          .where(eq(schema.businesses.domain, domain)).limit(1);
      }
      if (!existing) {
        const sameName = await tx.select().from(schema.businesses)
          .where(and(
            eq(schema.businesses.normalizedName, normalizedName),
            isNotNull(schema.businesses.lat),
          ));
        existing = sameName.find((business) => geoClose(
          business.lat,
          business.lng,
          candidate.lat,
          candidate.lng,
        ));
      }

      if (existing) {
        await attachSource(tx, existing.id, candidate);
        result = { kind: 'duplicate', businessId: existing.id };
        shouldQualify = existing.status === 'discovered';
      } else {
        let businessId = baseId;
        const suffix = collisionSuffix(candidate);
        for (let collision = 0; ; collision++) {
          const [taken] = await tx.select({ id: schema.businesses.id })
            .from(schema.businesses)
            .where(eq(schema.businesses.id, businessId))
            .limit(1);
          if (!taken) break;
          businessId = `${baseId}-${suffix}${collision ? `-${collision + 1}` : ''}`;
        }

        await tx.insert(schema.businesses).values({
          id: businessId,
          campaignId,
          name: candidate.name,
          normalizedName,
          category: candidate.category,
          address: candidate.address,
          lat: candidate.lat,
          lng: candidate.lng,
          phone: candidate.phone,
          normalizedPhone,
          websiteUrl: candidate.websiteUrl,
          domain,
          placeId: candidate.placeId,
          listingUrl: candidate.listingUrl,
          rating: candidate.rating,
          reviewCount: candidate.reviewCount,
          businessStatus: 'OPERATIONAL',
          status: 'discovered',
        });
        await tx.insert(schema.statusHistory).values({
          businessId,
          toStatus: 'discovered',
          actor: 'normalize-worker',
        });
        const sourceId = await attachSource(tx, businessId, candidate);
        const contacts = [
          candidate.phone
            ? { businessId, channel: 'phone', value: candidate.phone, sourceId, verified: true }
            : null,
          candidate.email
            ? { businessId, channel: 'email', value: candidate.email, sourceId, verified: true }
            : null,
        ].filter((contact): contact is NonNullable<typeof contact> => contact !== null);
        if (contacts.length) await tx.insert(schema.businessContacts).values(contacts);
        result = { kind: 'created', businessId };
        shouldQualify = true;
      }

      if (!shouldQualify || !result) return [];
      return [{
        name: 'fast-qualify',
        payload: {
          businessId: result.businessId,
          campaignId,
          idempotencyKey: `fast-qualify:${result.businessId}`,
        },
      }];
    });

    const normalizedResult = result as Omit<NormalizeCandidateResult, 'job'> | null;
    if (!normalizedResult) {
      throw new Error(`normalization of ${candidate.listingUrl} produced no result`);
    }
    return {
      kind: normalizedResult.kind,
      businessId: normalizedResult.businessId,
      job: shouldQualify ? jobs[0] ?? null : null,
    };
  }
}
