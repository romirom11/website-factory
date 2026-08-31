/**
 * Phase F — idempotent import of the legacy `website-offers` packages into the
 * factory database (spec §10 phase F, §5 data model).
 *
 * Guarantees:
 *  - LEGACY_DIR is READ-ONLY. Nothing here opens a legacy file for writing.
 *  - Idempotent: a second run over an unchanged tree creates 0 new businesses,
 *    0 new sources, 0 new facts, 0 new assets, 0 new status_history rows.
 *  - Dedup reuses the factory rules (place_id -> phone -> domain -> name+geo),
 *    so a later gosom discovery of the same business attaches to the SAME
 *    business_id instead of forking a second row. Dedup never deletes evidence.
 *  - Nothing is invented: a fact whose legacy `source_ids` do not resolve to a
 *    real uploaded source is stored UNVERIFIED and recorded as a gap.
 *  - No business reaches `production_ready` on import. Legacy packages have not
 *    passed the factory readiness gate, so honest mapping is `needs_review`
 *    (or `discovered` when legacy itself was only at discovery).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { normalizePhone, extractDomain, normalizeName, slugify } from '../discovery/normalization.js';
import { log } from '../lib/logger.js';
import { listLegacyClientIds, readLegacyClient, resolveRawRef } from './legacyReader.js';
import { ensureImportBuckets, guessContentType, putLegacyObject } from './storage.js';
import {
  allStrings, confidenceToNumber, deriveGaps, firstString, formatAddress,
  legacyGapLabels, mapFacts, mapSourceType, mapStatus, parseDate,
} from './mapping.js';
import type { LegacyClient, LegacySource } from './types.js';

export const IMPORT_ACTOR = 'legacy-import';
export const LEGACY_SOURCE_METHOD = 'legacy_import';
export const DEFAULT_LEGACY_CAMPAIGN = 'legacy-website-offers';

/** Placeholder source id used only while planning a --dry-run (no rows exist yet). */
const DRY_RUN_SOURCE_ID = -1;

export interface ImportOptions {
  legacyDir: string;
  campaignId?: string;
  /** Substring/id filters; when set, only matching client dirs are imported. */
  only?: string[];
  limit?: number;
  dryRun?: boolean;
}

export interface ClientImportResult {
  clientId: string;
  businessId: string | null;
  /** created = new business row; attached = matched an existing business via dedup. */
  outcome: 'created' | 'attached' | 'skipped' | 'failed';
  reason?: string;
  status?: string;
  statusReason?: string;
  counts: {
    sourcesCreated: number;
    sourcesExisting: number;
    objectsUploaded: number;
    factsCreated: number;
    factsUnverified: number;
    contactsCreated: number;
    assetsCreated: number;
    auditsCreated: number;
    gapsCreated: number;
    siteProjectsCreated: number;
  };
}

export interface ImportSummary {
  campaignId: string;
  legacyDir: string;
  dryRun: boolean;
  clientsSeen: number;
  created: number;
  attached: number;
  skipped: number;
  failed: number;
  results: ClientImportResult[];
}

function emptyCounts(): ClientImportResult['counts'] {
  return {
    sourcesCreated: 0, sourcesExisting: 0, objectsUploaded: 0,
    factsCreated: 0, factsUnverified: 0, contactsCreated: 0,
    assetsCreated: 0, auditsCreated: 0, gapsCreated: 0, siteProjectsCreated: 0,
  };
}

/** Ensure the umbrella campaign row for legacy imports exists. */
async function ensureCampaign(campaignId: string, dryRun: boolean): Promise<void> {
  const [existing] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (existing || dryRun) return;
  await db.insert(schema.campaigns).values({
    id: campaignId,
    country: 'gr',
    city: 'Patras',
    niche: 'beauty',
    language: 'el',
    queries: [],
    geofence: { lat: 38.246, lng: 21.735, radiusKm: 15 },
    targetCount: 0,
    mode: 'dry_run',
    status: 'done',
  }).onConflictDoNothing();
  log.info('legacy campaign ensured', { campaignId });
}

function geoClose(aLat: number | null, aLng: number | null, bLat: number | null, bLng: number | null): boolean {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return false;
  const dLat = (aLat - bLat) * 111_000;
  const dLng = (aLng - bLng) * 111_000 * Math.cos((aLat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) < 150; // 150m, same threshold as normalize worker
}

interface CandidateIdentity {
  name: string;
  placeId: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  websiteUrl: string | null;
  domain: string | null;
  listingUrl: string | null;
  lat: number | null;
  lng: number | null;
  category: string | null;
  address: string | null;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  normalizedName: string;
}

/**
 * Legacy Maps URLs embed a `place_ref` hex pair (`0x...:0x...`) rather than a
 * ChIJ place_id. That pair is what legacy dedup keyed on, so it is the strongest
 * identity signal available; it is namespaced to avoid colliding with real
 * Google place_ids from gosom.
 */
export function placeRefFromMapsUrl(mapsUrl: string | null): string | null {
  if (!mapsUrl) return null;
  const m = mapsUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Extract a real ChIJ-style place_id when the legacy URL carries one. */
export function chijPlaceIdFromMapsUrl(mapsUrl: string | null): string | null {
  if (!mapsUrl) return null;
  const m = mapsUrl.match(/!19s(ChIJ[A-Za-z0-9_-]+)/) ?? mapsUrl.match(/[?&]place_id=(ChIJ[A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function buildIdentity(client: LegacyClient): CandidateIdentity {
  const lead = client.lead;
  const name = firstString(lead.identity?.display_name?.value) ?? client.clientId;
  const mapsUrl = firstString(lead.location?.maps_url?.value);
  const explicitPlaceId = firstString(lead.location?.place_id?.value);
  const placeId = explicitPlaceId
    ?? chijPlaceIdFromMapsUrl(mapsUrl)
    // namespaced legacy fallback so it can never be mistaken for a Google place_id
    ?? (placeRefFromMapsUrl(mapsUrl) ? `legacy_place_ref:${placeRefFromMapsUrl(mapsUrl)}` : null);

  const phone = firstString(lead.contact?.phones?.value);
  const websiteUrl = firstString(lead.contact?.website?.value);
  const coords = lead.location?.coordinates?.value ?? null;
  const rating = typeof lead.presence?.rating?.value === 'number' ? lead.presence.rating.value : null;
  const reviewCount = typeof lead.presence?.reviews_count?.value === 'number' ? lead.presence.reviews_count.value : null;

  return {
    name,
    placeId,
    phone,
    normalizedPhone: normalizePhone(phone),
    websiteUrl,
    domain: extractDomain(websiteUrl),
    listingUrl: mapsUrl,
    lat: typeof coords?.lat === 'number' ? coords.lat : null,
    lng: typeof coords?.lng === 'number' ? coords.lng : null,
    category: firstString(lead.classification?.category?.value),
    address: formatAddress(lead.location?.address?.value ?? null),
    rating,
    reviewCount,
    businessStatus: (firstString(lead.classification?.business_status?.value) ?? '').toUpperCase() || null,
    normalizedName: normalizeName(name),
  };
}

/**
 * Same dedup order as `src/workers/normalize.ts`: place_id -> phone -> domain ->
 * name+geo. Returns the existing business row when this legacy client is the
 * same real-world business.
 */
async function findExistingBusiness(idt: CandidateIdentity): Promise<typeof schema.businesses.$inferSelect | undefined> {
  if (idt.placeId) {
    const [byPlace] = await db.select().from(schema.businesses).where(eq(schema.businesses.placeId, idt.placeId));
    if (byPlace) return byPlace;
  }
  if (idt.normalizedPhone) {
    const [byPhone] = await db.select().from(schema.businesses).where(eq(schema.businesses.normalizedPhone, idt.normalizedPhone));
    if (byPhone) return byPhone;
  }
  if (idt.domain) {
    const [byDomain] = await db.select().from(schema.businesses).where(eq(schema.businesses.domain, idt.domain));
    if (byDomain) return byDomain;
  }
  const sameName = await db.select().from(schema.businesses)
    .where(and(eq(schema.businesses.normalizedName, idt.normalizedName), isNotNull(schema.businesses.lat)));
  return sameName.find((b) => geoClose(b.lat, b.lng, idt.lat, idt.lng));
}

/** Deterministic business id, matching the normalize worker's `<country>-<city>-<slug>` shape. */
async function allocateBusinessId(idt: CandidateIdentity, country: string, city: string): Promise<string> {
  const base = `${country}-${slugify(city)}-${slugify(idt.name)}`;
  const [taken] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, base));
  if (!taken) return base;
  const discriminator = (idt.placeId ?? idt.listingUrl ?? idt.name).slice(-6).replace(/[^a-z0-9]/gi, '') || 'x';
  return `${base}-${discriminator}`;
}

interface UploadedSource {
  legacySourceId: string;
  dbSourceId: number;
  objectKey: string | null;
}

/**
 * Upload a legacy file as immutable evidence. Returns null when the file is
 * missing on disk (recorded as a gap by the caller, never invented).
 */
async function uploadEvidenceFile(
  legacyDir: string,
  relPath: string,
  mtimeIso: string | null,
): Promise<{ objectKey: string; uploaded: boolean } | null> {
  const abs = path.join(legacyDir, relPath);
  let body: Buffer;
  try {
    body = await readFile(abs);
  } catch {
    return null;
  }
  const res = await putLegacyObject('raw', relPath, body, guessContentType(relPath), {
    legacy_path: encodeURIComponent(relPath),
    legacy_mtime: mtimeIso ?? '',
    import_source: LEGACY_SOURCE_METHOD,
  });
  return { objectKey: res.objectKey, uploaded: res.uploaded };
}

async function fileMtimeIso(legacyDir: string, relPath: string): Promise<string | null> {
  try {
    const st = await stat(path.join(legacyDir, relPath));
    return st.mtime.toISOString();
  } catch { return null; }
}

/**
 * Create the business_sources rows for one legacy client.
 * Idempotency key: (businessId, url, rawObjectKey) — the raw key is content
 * addressed, so re-importing an unchanged file finds the same row.
 */
async function importSources(
  client: LegacyClient,
  businessId: string,
  legacyDir: string,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<{ uploaded: UploadedSource[]; unresolvedRawRefs: string[] }> {
  const uploaded: UploadedSource[] = [];
  const unresolvedRawRefs: string[] = [];
  const campaignIds = client.lead.campaign_ids ?? [];

  const existingRows = dryRun ? [] : await db.select().from(schema.businessSources)
    .where(eq(schema.businessSources.businessId, businessId));

  for (const src of client.sources) {
    const rawRef = src.raw_ref ?? null;
    let objectKey: string | null = null;
    let evidenceRelPath: string | null = null;

    if (rawRef) {
      evidenceRelPath = await resolveRawRef(legacyDir, client.clientId, campaignIds, rawRef);
      if (!evidenceRelPath) {
        unresolvedRawRefs.push(rawRef);
      } else {
        const mtime = await fileMtimeIso(legacyDir, evidenceRelPath);
        if (dryRun) {
          objectKey = `<dry-run>/${evidenceRelPath}`;
        } else {
          const up = await uploadEvidenceFile(legacyDir, evidenceRelPath, mtime);
          if (up) {
            objectKey = up.objectKey;
            if (up.uploaded) counts.objectsUploaded += 1;
          } else {
            unresolvedRawRefs.push(rawRef);
          }
        }
      }
    }

    const url = src.url
      ?? (evidenceRelPath ? `legacy://${evidenceRelPath}` : `legacy://clients/${client.clientId}#${src.source_id}`);

    const already = existingRows.find((r) => r.url === url && (r.rawObjectKey ?? null) === objectKey);
    if (already) {
      counts.sourcesExisting += 1;
      uploaded.push({ legacySourceId: src.source_id, dbSourceId: already.id, objectKey });
      continue;
    }

    if (dryRun) {
      counts.sourcesCreated += 1;
      // Sentinel id so the dry-run plan can still predict which facts would be
      // verifiable (a real id is only assigned on a live run).
      uploaded.push({ legacySourceId: src.source_id, dbSourceId: DRY_RUN_SOURCE_ID, objectKey });
      continue;
    }

    const [row] = await db.insert(schema.businessSources).values({
      businessId,
      sourceType: mapSourceType(src.source_type),
      url,
      capturedAt: parseDate(src.captured_at) ?? new Date(),
      method: LEGACY_SOURCE_METHOD,
      rawObjectKey: objectKey,
    }).returning({ id: schema.businessSources.id });
    counts.sourcesCreated += 1;
    uploaded.push({ legacySourceId: src.source_id, dbSourceId: row!.id, objectKey });
  }

  return { uploaded, unresolvedRawRefs };
}

/**
 * The legacy package files themselves (lead.yaml / status.yaml / sources.json /
 * manifest) are evidence too: they document what legacy claimed and when.
 * Stored as one `directory` source per client, content addressed.
 */
async function importPackageSnapshot(
  client: LegacyClient,
  businessId: string,
  legacyDir: string,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<void> {
  const relPath = path.join('clients', client.clientId, 'lead.yaml');
  const url = `legacy://${relPath}`;

  if (dryRun) { counts.sourcesCreated += 1; return; }

  const mtime = await fileMtimeIso(legacyDir, relPath);
  const up = await uploadEvidenceFile(legacyDir, relPath, mtime);
  if (!up) return;
  if (up.uploaded) counts.objectsUploaded += 1;

  const [already] = await db.select().from(schema.businessSources)
    .where(and(
      eq(schema.businessSources.businessId, businessId),
      eq(schema.businessSources.url, url),
      eq(schema.businessSources.rawObjectKey, up.objectKey),
    ));
  if (already) { counts.sourcesExisting += 1; return; }

  await db.insert(schema.businessSources).values({
    businessId,
    sourceType: 'directory',
    url,
    capturedAt: parseDate(client.lead.updated_at) ?? parseDate(client.lead.created_at) ?? new Date(),
    method: LEGACY_SOURCE_METHOD,
    rawObjectKey: up.objectKey,
  });
  counts.sourcesCreated += 1;
}

/** Facts: verified only when their legacy source_ids resolve to a created source row. */
async function importFacts(
  client: LegacyClient,
  businessId: string,
  sourceMap: Map<string, number>,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<string[]> {
  const unverifiedKeys: string[] = [];
  const existing = dryRun ? [] : await db.select().from(schema.businessFacts)
    .where(eq(schema.businessFacts.businessId, businessId));

  for (const fact of mapFacts(client)) {
    const resolvedId = fact.legacySourceIds.map((sid) => sourceMap.get(sid)).find((v): v is number => typeof v === 'number');
    const verified = resolvedId !== undefined;
    if (!verified) unverifiedKeys.push(fact.key);

    if (existing.some((f) => f.key === fact.key && JSON.stringify(f.value) === JSON.stringify(fact.value))) continue;
    counts.factsCreated += 1;
    if (!verified) counts.factsUnverified += 1;
    if (dryRun) continue;

    await db.insert(schema.businessFacts).values({
      businessId,
      key: fact.key,
      value: fact.value,
      // guard: the dry-run sentinel must never reach a real FK column
      sourceId: resolvedId !== undefined && resolvedId > 0 ? resolvedId : null,
      confidence: fact.confidence,
      extractionMethod: 'deterministic',
      verified,
      capturedAt: parseDate(client.lead.updated_at) ?? new Date(),
    });
  }
  return unverifiedKeys;
}

async function importContacts(
  client: LegacyClient,
  businessId: string,
  sourceMap: Map<string, number>,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<void> {
  const lead = client.lead;
  const existing = dryRun ? [] : await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.businessId, businessId));

  const entries: Array<{ channel: string; value: string; sourceIds: string[] }> = [];
  for (const v of allStrings(lead.contact?.phones?.value)) {
    entries.push({ channel: 'phone', value: v, sourceIds: lead.contact?.phones?.source_ids ?? [] });
  }
  for (const v of allStrings(lead.contact?.emails?.value)) {
    entries.push({ channel: 'email', value: v, sourceIds: lead.contact?.emails?.source_ids ?? [] });
  }

  for (const e of entries) {
    if (existing.some((c) => c.channel === e.channel && c.value === e.value)) continue;
    const resolvedId = e.sourceIds.map((sid) => sourceMap.get(sid)).find((v): v is number => typeof v === 'number');
    counts.contactsCreated += 1;
    if (dryRun) continue;
    await db.insert(schema.businessContacts).values({
      businessId,
      channel: e.channel,
      value: e.value,
      sourceId: resolvedId !== undefined && resolvedId > 0 ? resolvedId : null,
      // no traceable evidence => not verified (spec §5 invariant)
      verified: resolvedId !== undefined,
    });
  }
}

async function importAssets(
  client: LegacyClient,
  businessId: string,
  legacyDir: string,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<string[]> {
  const missing: string[] = [];
  const existing = dryRun ? [] : await db.select().from(schema.assets).where(eq(schema.assets.businessId, businessId));

  for (const asset of client.assets) {
    const rel = firstString(asset.path);
    if (!rel) continue;
    const relPath = path.join('clients', client.clientId, rel.startsWith('assets/') ? rel : path.join('assets', rel));
    let body: Buffer;
    try {
      body = await readFile(path.join(legacyDir, relPath));
    } catch {
      missing.push(relPath);
      continue;
    }

    const contentType = firstString(asset.content_type) ?? guessContentType(relPath);
    const res = dryRun
      ? { objectKey: `<dry-run>/${relPath}`, hash: '', uploaded: false }
      : await putLegacyObject('assets', relPath, body, contentType, {
        legacy_path: encodeURIComponent(relPath),
        import_source: LEGACY_SOURCE_METHOD,
      });

    if (!dryRun && existing.some((a) => a.hash === res.hash)) continue;
    counts.assetsCreated += 1;
    if (res.uploaded) counts.objectsUploaded += 1;
    if (dryRun) continue;

    const kind = (firstString(asset.kind) ?? 'gallery').toLowerCase();
    const usage = ['hero', 'logo', 'gallery', 'menu', 'demo'].includes(kind) ? kind : 'gallery';
    await db.insert(schema.assets).values({
      businessId,
      objectKey: res.objectKey,
      hash: res.hash,
      sourceUrl: firstString(asset.source_url) ?? `legacy://${relPath}`,
      sourceType: LEGACY_SOURCE_METHOD,
      contentType,
      width: typeof asset.width === 'number' ? asset.width : null,
      height: typeof asset.height === 'number' ? asset.height : null,
      intendedUsage: usage,
      // legacy photos are real business photos, never AI-generated
      rights: 'private_demo_only',
      capturedAt: parseDate(asset.captured_at) ?? new Date(),
    }).onConflictDoNothing();
  }
  return missing;
}

async function importAudits(
  client: LegacyClient,
  businessId: string,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<void> {
  if (client.audits.length === 0) return;
  const existing = dryRun ? [] : await db.select().from(schema.websiteAudits)
    .where(eq(schema.websiteAudits.businessId, businessId));

  const known = ['none', 'unreachable_all_endpoints', 'working_with_https_issue', 'working_but_dated', 'acceptable', 'strong_modern'];

  for (const { relPath, audit } of client.audits) {
    const verdictRaw = (firstString(audit.verdict) ?? '').toLowerCase();
    const verdict = known.includes(verdictRaw) ? verdictRaw : 'none';
    const note = `legacy-import from ${relPath}${verdictRaw && verdict !== verdictRaw ? ` (unmapped legacy verdict: ${verdictRaw})` : ''}`;
    if (existing.some((a) => (a.notes ?? '').startsWith(`legacy-import from ${relPath}`))) continue;
    counts.auditsCreated += 1;
    if (dryRun) continue;
    await db.insert(schema.websiteAudits).values({
      businessId,
      endpointMatrix: (audit.endpoint_matrix ?? audit.endpoints ?? null) as never,
      bestEndpoint: firstString(audit.best_endpoint),
      verdict,
      meaningfulContent: typeof audit.meaningful_content === 'boolean' ? audit.meaningful_content : null,
      notes: [note, firstString(audit.notes)].filter(Boolean).join(' | '),
      auditedAt: parseDate(audit.audited_at) ?? new Date(),
    });
  }
}

async function importSiteProject(
  client: LegacyClient,
  businessId: string,
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<void> {
  if (!client.websiteDir) return;
  const dir = path.join('clients', client.clientId, client.websiteDir);
  const existing = dryRun ? [] : await db.select().from(schema.siteProjects)
    .where(and(eq(schema.siteProjects.businessId, businessId), eq(schema.siteProjects.dir, dir)));
  if (existing.length) return;
  counts.siteProjectsCreated += 1;
  if (dryRun) return;
  await db.insert(schema.siteProjects).values({
    businessId,
    dir,
    // legacy demo is recorded, NOT deployed and NOT trusted as build-verified
    state: 'needs_human_review',
    buildOk: null,
    deployUrl: null,
  });
}

async function importGaps(
  client: LegacyClient,
  businessId: string,
  resolvedSourceCount: number,
  extraGaps: string[],
  counts: ClientImportResult['counts'],
  dryRun: boolean,
): Promise<string[]> {
  const hard = [...deriveGaps(client, resolvedSourceCount), ...extraGaps];
  const soft = legacyGapLabels(client);
  const existing = dryRun ? [] : await db.select().from(schema.productionGaps)
    .where(and(eq(schema.productionGaps.businessId, businessId), eq(schema.productionGaps.resolved, false)));

  const all: Array<{ gap: string; level: 'hard' | 'soft' }> = [
    ...hard.map((g) => ({ gap: g, level: 'hard' as const })),
    ...soft.map((g) => ({ gap: g.gap, level: g.blocking ? ('hard' as const) : ('soft' as const) })),
  ];

  for (const g of all) {
    if (existing.some((e) => e.gap === g.gap)) continue;
    counts.gapsCreated += 1;
    if (dryRun) continue;
    await db.insert(schema.productionGaps).values({ businessId, gap: g.gap, blockerLevel: g.level });
  }
  return hard;
}

/** Import one legacy client. Failures are contained: one bad client never stops the run. */
export async function importClient(
  legacyDir: string,
  clientId: string,
  campaignId: string,
  dryRun: boolean,
): Promise<ClientImportResult> {
  const counts = emptyCounts();
  let client: LegacyClient;
  try {
    client = await readLegacyClient(legacyDir, clientId);
  } catch (err) {
    return { clientId, businessId: null, outcome: 'failed', reason: String(err).slice(0, 200), counts };
  }

  const idt = buildIdentity(client);
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  const country = campaign?.country ?? 'gr';
  const city = campaign?.city ?? 'Patras';

  const existing = await findExistingBusiness(idt);
  const mapped = mapStatus(client.status.status);

  let businessId: string;
  let outcome: ClientImportResult['outcome'];

  if (existing) {
    businessId = existing.id;
    outcome = 'attached';
    // Attaching evidence never rewrites an existing business's status: the
    // factory's own pipeline owns that. Only fill columns that are still empty.
    if (!dryRun) {
      const patch: Record<string, unknown> = {};
      if (!existing.placeId && idt.placeId) patch.placeId = idt.placeId;
      if (!existing.phone && idt.phone) { patch.phone = idt.phone; patch.normalizedPhone = idt.normalizedPhone; }
      if (!existing.websiteUrl && idt.websiteUrl) { patch.websiteUrl = idt.websiteUrl; patch.domain = idt.domain; }
      if (!existing.address && idt.address) patch.address = idt.address;
      if (existing.lat == null && idt.lat != null) { patch.lat = idt.lat; patch.lng = idt.lng; }
      if (existing.rating == null && idt.rating != null) patch.rating = idt.rating;
      if (existing.reviewCount == null && idt.reviewCount != null) patch.reviewCount = idt.reviewCount;
      if (Object.keys(patch).length) {
        patch.updatedAt = new Date();
        await db.update(schema.businesses).set(patch).where(eq(schema.businesses.id, businessId));
      }
    }
  } else {
    businessId = await allocateBusinessId(idt, country, city);
    outcome = 'created';
    if (!dryRun) {
      await db.insert(schema.businesses).values({
        id: businessId,
        campaignId,
        name: idt.name,
        normalizedName: idt.normalizedName,
        category: idt.category,
        address: idt.address,
        lat: idt.lat,
        lng: idt.lng,
        phone: idt.phone,
        normalizedPhone: idt.normalizedPhone,
        websiteUrl: idt.websiteUrl,
        domain: idt.domain,
        placeId: idt.placeId,
        listingUrl: idt.listingUrl,
        rating: idt.rating,
        reviewCount: idt.reviewCount,
        businessStatus: idt.businessStatus,
        status: mapped.status,
        statusReason: mapped.reason,
      });
      await db.insert(schema.statusHistory).values({
        businessId,
        fromStatus: null,
        toStatus: mapped.status,
        reason: mapped.reason,
        actor: IMPORT_ACTOR,
      });
    }
  }

  const { uploaded, unresolvedRawRefs } = await importSources(client, businessId, legacyDir, counts, dryRun);
  await importPackageSnapshot(client, businessId, legacyDir, counts, dryRun);

  const sourceMap = new Map<string, number>();
  for (const u of uploaded) {
    // A source with no resolvable raw file still proves provenance via its URL,
    // but only uploaded evidence makes a fact verifiable.
    // In --dry-run the id is the sentinel: the plan reports what WOULD be verified.
    if ((u.dbSourceId > 0 || (dryRun && u.dbSourceId === DRY_RUN_SOURCE_ID)) && u.objectKey) {
      sourceMap.set(u.legacySourceId, u.dbSourceId);
    }
  }

  const unverifiedKeys = await importFacts(client, businessId, sourceMap, counts, dryRun);
  await importContacts(client, businessId, sourceMap, counts, dryRun);
  const missingAssets = await importAssets(client, businessId, legacyDir, counts, dryRun);
  await importAudits(client, businessId, counts, dryRun);
  await importSiteProject(client, businessId, counts, dryRun);

  const extraGaps: string[] = [];
  for (const ref of unresolvedRawRefs) extraGaps.push(`legacy_raw_missing:${ref}`.slice(0, 200));
  for (const p of missingAssets) extraGaps.push(`legacy_asset_missing:${p}`.slice(0, 200));
  if (unverifiedKeys.length) extraGaps.push(`unverified_facts:${unverifiedKeys.join(',')}`.slice(0, 200));

  await importGaps(client, businessId, sourceMap.size, extraGaps, counts, dryRun);

  return {
    clientId,
    businessId,
    outcome,
    status: existing ? existing.status : mapped.status,
    statusReason: existing ? (existing.statusReason ?? undefined) : mapped.reason,
    counts,
  };
}

export async function runImport(opts: ImportOptions): Promise<ImportSummary> {
  const legacyDir = path.resolve(opts.legacyDir);
  const campaignId = opts.campaignId ?? DEFAULT_LEGACY_CAMPAIGN;
  const dryRun = opts.dryRun === true;

  if (!dryRun) await ensureImportBuckets();
  await ensureCampaign(campaignId, dryRun);

  let ids = await listLegacyClientIds(legacyDir);
  if (opts.only?.length) {
    const needles = opts.only.map((s) => s.toLowerCase());
    ids = ids.filter((id) => needles.some((n) => id.toLowerCase() === n || id.toLowerCase().includes(n)));
  }
  if (opts.limit && opts.limit > 0) ids = ids.slice(0, opts.limit);

  const summary: ImportSummary = {
    campaignId, legacyDir, dryRun,
    clientsSeen: ids.length, created: 0, attached: 0, skipped: 0, failed: 0, results: [],
  };

  for (const clientId of ids) {
    let result: ClientImportResult;
    try {
      result = await importClient(legacyDir, clientId, campaignId, dryRun);
    } catch (err) {
      // one failing business never stops the run (spec invariant)
      result = { clientId, businessId: null, outcome: 'failed', reason: String(err).slice(0, 300), counts: emptyCounts() };
    }
    summary.results.push(result);
    if (result.outcome === 'created') summary.created += 1;
    else if (result.outcome === 'attached') summary.attached += 1;
    else if (result.outcome === 'skipped') summary.skipped += 1;
    else summary.failed += 1;

    log.info('legacy client imported', {
      clientId: result.clientId,
      businessId: result.businessId,
      outcome: result.outcome,
      status: result.status,
      ...result.counts,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  return summary;
}
