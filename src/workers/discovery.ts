/**
 * Discovery worker: a THIN client of gosom/google-maps-scraper's REST API (spec §3).
 * This worker never scrapes Google itself — gosom owns the browser, the selectors
 * and the proxies. We only: create a job, poll it, download its output, keep the
 * raw output immutably as evidence, and map records into candidates.
 *
 * gosom REST contract (verified against v1.17.3, `-web` mode; note that v1.14.0
 * is unusable — it fetches the Playwright driver from the now-dead
 * playwright.azureedge.net and every job hangs in `working`):
 *   POST   /api/v1/jobs             {name, keywords[], lang, zoom, lat, lon, fast_mode,
 *                                    radius, depth, email, extra_reviews, max_time, proxies[]}
 *                                   -> 201 {id}
 *   GET    /api/v1/jobs/{id}        -> {ID, Name, Date, Status, Data}
 *                                      Status: pending | working | ok | failed
 *   GET    /api/v1/jobs/{id}/download -> text/csv (36 columns, gmaps.Entry.CsvHeaders)
 *
 * Two gotchas encoded here:
 *  - `max_time` is sent in SECONDS (the server multiplies by time.Second) and
 *    gosom rejects anything <= 3m;
 *  - results are CSV only. The map-view JSON endpoint carries just 9 fields and
 *    drops emails, so the CSV is the real payload and what we store as evidence.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { putRaw } from '../lib/storage.js';
import { enqueue, type JobPayload } from '../orchestrator/queue.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { notifyTelegram } from '../telegram/notify.js';

export interface RawCandidate {
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  websiteUrl: string | null;
  listingUrl: string;
  placeId: string | null;
  rating: number | null;
  reviewCount: number | null;
  lat: number | null;
  lng: number | null;
  rawObjectKey: string;
  query: string;
}

export interface GosomJobData {
  keywords: string[];
  lang: string;
  zoom: number;
  lat: string;
  lon: string;
  fast_mode: boolean;
  radius: number;
  depth: number;
  email: boolean;
  extra_reviews: boolean;
  max_time: number; // SECONDS — server converts to a Go duration
  proxies: string[];
}

interface GosomJob {
  ID: string;
  Name: string;
  Date: string;
  Status: 'pending' | 'working' | 'ok' | 'failed';
  Data: GosomJobData;
}

/** Raised when gosom itself is the problem (down, refusing jobs, failing them). */
export class DiscoveryUnavailableError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gosomFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${config.gosom.url}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(config.gosom.requestTimeoutSeconds * 1000),
    });
  } catch (err) {
    throw new DiscoveryUnavailableError(`gosom unreachable at ${url}: ${String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DiscoveryUnavailableError(`gosom ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

export async function createGosomJob(name: string, data: GosomJobData): Promise<string> {
  const res = await gosomFetch('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...data }),
  });
  const json = (await res.json()) as { id?: string };
  if (!json?.id) throw new DiscoveryUnavailableError(`gosom returned no job id: ${JSON.stringify(json).slice(0, 200)}`);
  return json.id;
}

export async function getGosomJob(id: string): Promise<GosomJob> {
  const res = await gosomFetch(`/api/v1/jobs/${id}`);
  return (await res.json()) as GosomJob;
}

/** Polls until the job leaves pending/working. Throws on `failed` or timeout. */
export async function waitForGosomJob(id: string): Promise<GosomJob> {
  const deadline = Date.now() + config.gosom.jobTimeoutSeconds * 1000;
  let last = '';
  for (;;) {
    let job: GosomJob;
    try {
      job = await getGosomJob(id);
    } catch (error) {
      if (!(error instanceof DiscoveryUnavailableError)) throw error;
      if (Date.now() > deadline) {
        throw new DiscoveryUnavailableError(
          `gosom job ${id} could not be polled for ${config.gosom.jobTimeoutSeconds}s: ${error.message}`,
        );
      }
      if (last !== 'unreachable') {
        log.warn('gosom job polling temporarily unavailable', {
          jobId: id,
          error: error.message.slice(0, 300),
        });
        last = 'unreachable';
      }
      await sleep(config.gosom.pollIntervalSeconds * 1000);
      continue;
    }
    if (job.Status !== last) {
      log.info('gosom job status', { jobId: id, status: job.Status });
      last = job.Status;
    }
    if (job.Status === 'ok') return job;
    if (job.Status === 'failed') throw new DiscoveryUnavailableError(`gosom job ${id} failed`);
    if (Date.now() > deadline) {
      throw new DiscoveryUnavailableError(
        `gosom job ${id} still ${job.Status} after ${config.gosom.jobTimeoutSeconds}s`,
      );
    }
    await sleep(config.gosom.pollIntervalSeconds * 1000);
  }
}

export async function downloadGosomCsv(id: string): Promise<string> {
  const res = await gosomFetch(`/api/v1/jobs/${id}/download`);
  return res.text();
}

/** RFC4180 CSV parser: gosom embeds JSON blobs with commas/quotes/newlines in cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !started) { quoted = true; started = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRow(); continue; }
    field += c;
    started = true;
  }
  // trailing newline produces no extra row; anything buffered is a final row
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

function text(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/**
 * Maps gosom CSV rows to candidates. Columns are resolved by header NAME, never
 * by position, so a gosom release reordering its CSV cannot silently shift data.
 */
export function mapCsvToCandidates(csv: string, query: string, rawObjectKey: string): RawCandidate[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name);
    return i === -1 ? undefined : i;
  };
  const idx = {
    title: col('title'), link: col('link'), category: col('category'), address: col('address'),
    website: col('website'), phone: col('phone'), reviewCount: col('review_count'),
    rating: col('review_rating'), lat: col('latitude'), lng: col('longitude'),
    placeId: col('place_id'), cid: col('cid'), emails: col('emails'), status: col('status'),
  };
  if (idx.title === undefined) {
    throw new DiscoveryUnavailableError(`gosom CSV has no "title" column; headers: ${header.join(',')}`);
  }

  const out: RawCandidate[] = [];
  for (const row of rows.slice(1)) {
    const at = (i: number | undefined) => (i === undefined ? undefined : row[i]);
    const name = text(at(idx.title));
    if (!name) continue; // blank/short row
    // gosom joins multiple emails with ", "; keep the first, evidence holds all
    const email = text(at(idx.emails))?.split(',')[0]?.trim() ?? null;
    const link = text(at(idx.link));
    const placeId = text(at(idx.placeId)) ?? text(at(idx.cid));
    out.push({
      name,
      category: text(at(idx.category)),
      address: text(at(idx.address)),
      phone: text(at(idx.phone)),
      email: email && email.includes('@') ? email : null,
      websiteUrl: text(at(idx.website)),
      listingUrl: link ?? `https://www.google.com/maps/search/${encodeURIComponent(name)}`,
      placeId,
      rating: num(at(idx.rating)),
      reviewCount: num(at(idx.reviewCount)),
      lat: num(at(idx.lat)),
      lng: num(at(idx.lng)),
      rawObjectKey,
      query,
    });
  }
  return out;
}

/**
 * gosom searches each keyword globally, so the city belongs in the keyword.
 * Queries are written per-language ("κομμωτήριο Πάτρα" alongside "hair salon
 * Patras"), and a Greek query already names the city in Greek — appending the
 * Latin name would produce "κομμωτήριο Πάτρα Patras". So the city is added only
 * when the query is in the same script as the city name and does not contain it.
 */
export function appendCity(query: string, city: string): string {
  const q = query.trim();
  const c = city.trim();
  if (!c) return q;
  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (fold(q).includes(fold(c))) return q;
  const isGreek = (s: string) => /\p{Script=Greek}/u.test(s);
  // a Greek query carries its own Greek city name; don't mix scripts
  if (isGreek(q) !== isGreek(c)) return q;
  return `${q} ${c}`;
}

export async function discoverHandler(payload: JobPayload): Promise<void> {
  const campaignId = payload.campaignId!;
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
  if (!campaign.queries?.length) throw new Error(`campaign ${campaignId} has no queries`);

  const keywords = campaign.queries.map((q) => appendCity(q, campaign.city));
  const geo = campaign.geofence;
  const jobData: GosomJobData = {
    keywords,
    lang: campaign.language.slice(0, 2),
    zoom: config.gosom.zoom,
    lat: String(geo?.lat ?? 0),
    lon: String(geo?.lng ?? 0),
    fast_mode: false,           // fast mode drops phone/website/email — useless here
    radius: config.gosom.radiusMeters,
    depth: config.gosom.depth,
    email: config.gosom.email,  // decision #7: email extraction on from campaign one
    extra_reviews: false,
    max_time: config.gosom.maxTimeSeconds,
    proxies: config.gosom.proxies, // decision #3: empty until proxies are needed
  };

  const jobName = `${campaignId}-${Date.now()}`;
  let candidates: RawCandidate[];
  let gosomJobId: string;

  try {
    gosomJobId = await createGosomJob(jobName, jobData);
    log.info('gosom job created', { campaignId, gosomJobId, keywords: keywords.length, depth: jobData.depth });

    await waitForGosomJob(gosomJobId);
    const csv = await downloadGosomCsv(gosomJobId);

    // Full raw output stored immutably BEFORE any parsing: evidence first.
    const rawObjectKey = await putRaw(`discovery/${campaignId}/gosom-${gosomJobId}`, csv, 'text/csv');
    log.info('gosom raw evidence stored', { campaignId, gosomJobId, rawObjectKey, bytes: csv.length });

    candidates = mapCsvToCandidates(csv, keywords.join(' | '), rawObjectKey);
  } catch (err) {
    // gosom down / job failed / unparsable output: loud failure, never a silent zero.
    await notifyTelegram(
      `🚨 Discovery failed for campaign <b>${campaignId}</b>\n` +
      `gosom: ${config.gosom.url}\n` +
      `error: ${String((err as Error)?.message ?? err).slice(0, 400)}`,
    ).catch(() => {});
    throw err;
  }

  if (candidates.length === 0) {
    // spec §7: "gosom returned 0 -> failure with an alert, not a silent skip"
    await notifyTelegram(
      `🚨 Discovery returned <b>0 candidates</b> for campaign <b>${campaignId}</b>\n` +
      `gosom job: ${gosomJobId}\nqueries: ${keywords.join(', ')}\n` +
      `Check gosom logs — a block or a Maps layout change looks likely.`,
    ).catch(() => {});
    throw new Error(`gosom job ${gosomJobId} returned 0 candidates for campaign ${campaignId}`);
  }

  // Respect the campaign's own limit (spec §3.5).
  const limited = candidates.slice(0, campaign.targetCount);

  for (const cand of limited) {
    await enqueue('normalize', {
      campaignId,
      candidate: cand as unknown as Record<string, unknown>,
      idempotencyKey: `normalize:${campaignId}:${cand.placeId ?? cand.listingUrl}`,
    });
  }
  log.info('discovery done', {
    campaignId, gosomJobId,
    scraped: candidates.length, enqueued: limited.length,
    withWebsite: limited.filter((c) => c.websiteUrl).length,
    withPhone: limited.filter((c) => c.phone).length,
    withEmail: limited.filter((c) => c.email).length,
  });
}
