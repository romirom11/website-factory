import { desc, sql } from 'drizzle-orm';
import {
  pgTable, text, integer, real, boolean, timestamp, jsonb, serial, uuid, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

// ─── Campaigns ────────────────────────────────────────────────────────────────

export const campaigns = pgTable('campaigns', {
  id: text('id').primaryKey(), // e.g. gr-patras-beauty-2026-08
  country: text('country').notNull(),
  city: text('city').notNull(),
  niche: text('niche').notNull(),
  language: text('language').notNull().default('el'),
  queries: jsonb('queries').$type<string[]>().notNull(),
  geofence: jsonb('geofence').$type<{ lat: number; lng: number; radiusKm: number }>().notNull(),
  targetCount: integer('target_count').notNull().default(50),
  mode: text('mode').notNull().default('dry_run'), // dry_run | live
  status: text('status').notNull().default('created'), // created | running | paused | done
  /**
   * Which production_ready businesses the factory starts building for on its own.
   * Roman's rule: first serve the businesses that have NO site — a demo for a
   * shop with a good modern site is subscription time spent on the wrong lead.
   *
   *   no_site_only (default) — only when the latest audit verdict is
   *                            no_website | broken
   *   all                    — every production_ready business
   *   manual                 — never automatically; only the UI "Будувати демо" button
   *
   * The gate lives in `src/orchestrator/buildPolicy.ts`; the state machine is
   * untouched — an ineligible business simply waits in `production_ready`.
   */
  autoBuild: text('auto_build').notNull().default('no_site_only'), // no_site_only | all | manual
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Businesses (stable identity) ────────────────────────────────────────────

export const businesses = pgTable('businesses', {
  id: text('id').primaryKey(), // <country>-<city>-<slug>
  campaignId: text('campaign_id').notNull().references(() => campaigns.id),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  category: text('category'),
  address: text('address'),
  lat: real('lat'),
  lng: real('lng'),
  phone: text('phone'),
  normalizedPhone: text('normalized_phone'),
  websiteUrl: text('website_url'),
  domain: text('domain'),
  placeId: text('place_id'),
  listingUrl: text('listing_url'),
  rating: real('rating'),
  reviewCount: integer('review_count'),
  businessStatus: text('business_status'),
  status: text('status').notNull().default('discovered'),
  statusReason: text('status_reason'),
  score: real('score'),
  scoreBreakdown: jsonb('score_breakdown').$type<Record<string, number>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => [
  index('biz_campaign_idx').on(t.campaignId),
  index('biz_status_idx').on(t.status),
  uniqueIndex('biz_place_idx').on(t.placeId),
]);

export const statusHistory = pgTable('status_history', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  actor: text('actor').notNull(), // worker name | 'roman' | 'system'
  at: timestamp('at').notNull().defaultNow(),
});

// ─── Evidence: sources, facts, contacts, assets ───────────────────────────────

export const businessSources = pgTable('business_sources', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  sourceType: text('source_type').notNull(), // google_maps | owned_website | facebook | instagram | search | directory
  url: text('url').notNull(),
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
  method: text('method').notNull(), // gosom_api | playwright | http | agent
  rawObjectKey: text('raw_object_key'), // immutable raw snapshot in S3
  version: integer('version').notNull().default(1),
}, (t) => [index('src_biz_idx').on(t.businessId)]);

export const businessFacts = pgTable('business_facts', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  key: text('key').notNull(), // identity.description | services[] | hours | price.x ...
  value: jsonb('value'),
  sourceId: integer('source_id').references(() => businessSources.id),
  confidence: real('confidence').notNull().default(0.5),
  extractionMethod: text('extraction_method').notNull(), // deterministic | llm_structured
  verified: boolean('verified').notNull().default(false),
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
}, (t) => [index('fact_biz_idx').on(t.businessId), index('fact_key_idx').on(t.businessId, t.key)]);

export const businessContacts = pgTable('business_contacts', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  channel: text('channel').notNull(), // email | phone | whatsapp | instagram | facebook | contact_form
  value: text('value').notNull(),
  sourceId: integer('source_id').references(() => businessSources.id),
  verified: boolean('verified').notNull().default(false),
  /**
   * Set only when a PERSON confirmed the contact (Roman, from the business
   * card). NULL means the matcher decided it on its own — a distinction the
   * bare `verified` flag would lose, and the same reason status_history carries
   * an actor.
   */
  verifiedBy: text('verified_by'),
  verifiedNote: text('verified_note'),
}, (t) => [index('contact_biz_idx').on(t.businessId)]);

export const assets = pgTable('assets', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  objectKey: text('object_key').notNull(),
  hash: text('hash').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceType: text('source_type').notNull(),
  contentType: text('content_type'),
  width: integer('width'),
  height: integer('height'),
  intendedUsage: text('intended_usage').notNull().default('demo'), // hero | logo | gallery | menu | demo | background | pattern | og | hero_clip
  rights: text('rights').notNull().default('private_demo_only'),
  // Media generation (SPEC §2.5, decisions #12/#13). AI media is decorative and
  // is NEVER presented as a real photo/video of the business.
  aiGenerated: boolean('ai_generated').notNull().default(false),
  generator: text('generator'), // gen-image:gpt-image-2 | ken-burns | manual-upload (historic rows may say flowkit:*)
  generationMeta: jsonb('generation_meta'), // prompt, model, ref asset, duration...
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
}, (t) => [index('asset_biz_idx').on(t.businessId), uniqueIndex('asset_hash_idx').on(t.businessId, t.hash)]);

// ─── Audits, qualification, gaps ─────────────────────────────────────────────

export const websiteAudits = pgTable('website_audits', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  endpointMatrix: jsonb('endpoint_matrix').$type<Array<{
    url: string; status: number | null; finalUrl: string | null; tlsOk: boolean | null; error: string | null;
  }>>(),
  bestEndpoint: text('best_endpoint'),
  verdict: text('verdict').notNull(), // none | unreachable_all_endpoints | working_with_https_issue | working_but_dated | acceptable | strong_modern
  desktopScreenshotKey: text('desktop_screenshot_key'),
  // Full-page desktop capture. Extra evidence next to the viewport shot: the
  // viewport alone shows the top 900px, which on a slow JS site is a cookie
  // banner over an empty hero — not enough to check a verdict by eye.
  desktopFullScreenshotKey: text('desktop_full_screenshot_key'),
  mobileScreenshotKey: text('mobile_screenshot_key'),
  meaningfulContent: boolean('meaningful_content'),
  notes: text('notes'),
  auditedAt: timestamp('audited_at').notNull().defaultNow(),
}, (t) => [
  index('audit_biz_idx').on(t.businessId),
  // "Latest verdict per business" is read by the build policy and by every
  // funnel render, so it gets its own covering order.
  index('audit_biz_latest_idx').on(t.businessId, desc(t.auditedAt)),
]);

export const qualifications = pgTable('qualifications', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  stage: text('stage').notNull(), // fast | full
  qualified: boolean('qualified').notNull(),
  reasons: jsonb('reasons').$type<string[]>().notNull(),
  score: real('score'),
  scoreBreakdown: jsonb('score_breakdown').$type<Record<string, number>>(),
  qaPassed: boolean('qa_passed'),
  qaNotes: text('qa_notes'),
  /**
   * `qaNotes` in Ukrainian. The critic writes English; Roman reads Ukrainian.
   * The English stays as the record of what the critic actually said — null
   * here means untranslated, and the reader falls back to `qaNotes`.
   */
  qaNotesUk: text('qa_notes_uk'),
  at: timestamp('at').notNull().defaultNow(),
});

export const productionGaps = pgTable('production_gaps', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  gap: text('gap').notNull(), // verified_contact | services_min3 | assets_min3 | hero_or_logo | review_context | identity
  /**
   * `gap` in Ukrainian, for the SOFT gaps only — those are whole sentences the
   * enrichment agent writes in the language of the evidence (Greek in Patras).
   * Hard gaps are keys with a code-side Ukrainian name, so they never need one.
   * Null = untranslated; the UI falls back to `gap` rather than showing nothing.
   */
  gapUk: text('gap_uk'),
  blockerLevel: text('blocker_level').notNull().default('hard'), // hard | soft
  resolved: boolean('resolved').notNull().default(false),
  at: timestamp('at').notNull().defaultNow(),
});

// ─── Sites ────────────────────────────────────────────────────────────────────

export const siteProjects = pgTable('site_projects', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  dir: text('dir').notNull(),
  /** Frozen build snapshot (SPEC §4 stage 10): the exact facts this site was built from. */
  snapshotKey: text('snapshot_key'),
  contentBriefKey: text('content_brief_key'),
  designContractKey: text('design_contract_key'),
  designDirection: text('design_direction'),
  // Mirrors of the frozen contract, written at freeze time (MOTION-PLAN D1/D2):
  // campaign-wide diversity aggregates read these instead of opening N contract
  // JSONs. NULL on rows older than migration 0014 — they just don't count.
  referenceSlug: text('reference_slug'),
  displayFont: text('display_font'),
  signature: text('signature'),
  /** Score the deterministic rubric gave the chosen direction (src/build/rubric.ts). */
  designScore: real('design_score'),
  /**
   * The six 0-3 wow axes (`references/motion/README.md`), scored twice: `design`
   * is what the chosen art direction PROMISED at stage 9, `qa` is what the built
   * page actually delivered at stage 11. The gap between them is the interesting
   * number — a direction can promise a scroll-linked hero and still ship a static
   * one. See `drizzle/0009_wow_scores.sql` for the shape.
   */
  wowScores: jsonb('wow_scores').$type<{
    design?: {
      total: number; ambition?: number; passed: boolean; reasons: string[];
      axes: Record<string, number>;
      referenceSlug?: string; heroMotion?: string;
    };
    qa?: {
      iteration: number; total: number; ambition?: number; passed: boolean; reasons: string[];
      axes: Record<string, number>;
      heroMotionDetected?: boolean;
      /** Entrance window, 0.15s → 1.6s after load. */
      heroMotionPixelDelta?: number;
      /** Sustained window, 2.4s → 3.6s: is the hero still moving once entrances end? */
      heroSustainedPixelDelta?: number;
      referenceCloseness?: number;
    };
  }>(),
  buildOk: boolean('build_ok'),
  /** Wall-clock seconds of the last builder agent session. */
  buildSeconds: integer('build_seconds'),
  qaIterations: integer('qa_iterations').notNull().default(0),
  /** Latest QA report; every iteration also keeps its own key in qaReportKeys. */
  qaReportKey: text('qa_report_key'),
  qaReportKeys: jsonb('qa_report_keys').$type<string[]>(),
  screenshotKeys: jsonb('screenshot_keys').$type<string[]>(),
  /** Deterministic + critic issues still open at the last QA pass. */
  openIssues: jsonb('open_issues').$type<string[]>(),
  deployUrl: text('deploy_url'),
  /** Unguessable path segment under deploys/; kept so a redeploy reuses the URL. */
  deployToken: text('deploy_token'),
  deployedAt: timestamp('deployed_at'),
  state: text('state').notNull().default('pending'), // pending | brief | building | qa | needs_human_review | ready | deployed
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [index('site_project_biz_idx').on(t.businessId)]);

// ─── Approvals, outreach, deals ──────────────────────────────────────────────

export const approvals = pgTable('approvals', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  kind: text('kind').notNull().default('outreach'),
  decision: text('decision'), // approved | rejected | needs_changes
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at'),
  telegramMessageId: text('telegram_message_id'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const outreachMessages = pgTable('outreach_messages', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  channel: text('channel').notNull(), // email | whatsapp | instagram_manual
  toAddress: text('to_address').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  providerMessageId: text('provider_message_id'),
  kind: text('kind').notNull().default('initial'), // initial | followup_1 | followup_2
  state: text('state').notNull().default('queued'), // queued | sent | delivered | failed | simulated | manual_pending
  sentAt: timestamp('sent_at'),
}, (t) => [uniqueIndex('outreach_idem_idx').on(t.idempotencyKey), index('outreach_biz_idx').on(t.businessId)]);

export const outreachEvents = pgTable('outreach_events', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  messageId: integer('message_id').references(() => outreachMessages.id),
  event: text('event').notNull(), // sent | delivered | bounced | replied | opted_out
  detail: jsonb('detail'),
  at: timestamp('at').notNull().defaultNow(),
});

export const deals = pgTable('deals', {
  id: serial('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id).unique(),
  state: text('state').notNull().default('contacted'), // contacted | replied | meeting | proposal | won | lost
  value: real('value'),
  recurring: real('recurring'),
  lostReason: text('lost_reason'),
  nextAction: text('next_action'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const doNotContact = pgTable('do_not_contact', {
  id: serial('id').primaryKey(),
  matchType: text('match_type').notNull(), // email | phone | domain | business_id
  value: text('value').notNull(),
  reason: text('reason'),
  at: timestamp('at').notNull().defaultNow(),
}, (t) => [uniqueIndex('dnc_idx').on(t.matchType, t.value)]);

// ─── Jobs: logical commands + physical pg-boss attempts ─────────────────────

export const workflowJobRuns = pgTable('workflow_job_runs', {
  id: uuid('id').primaryKey(),
  jobType: text('job_type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  businessId: text('business_id'),
  campaignId: text('campaign_id'),
  // queued | running | retry_wait | succeeded | failed | needs_human | cancelled
  status: text('status').notNull().default('queued'),
  currentAttemptSequence: integer('current_attempt_sequence').notNull().default(1),
  /** Number of enqueue commands intentionally collapsed into this active run. */
  duplicateSuppressions: integer('duplicate_suppressions').notNull().default(0),
  /** Lets the operator distinguish an old run from current duplicate traffic. */
  lastDuplicateAt: timestamp('last_duplicate_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
}, (t) => [
  uniqueIndex('workflow_runs_active_idem_idx')
    .on(t.jobType, t.idempotencyKey)
    .where(sql`${t.status} in ('queued', 'running', 'retry_wait')`),
  index('workflow_runs_status_idx').on(t.status),
  index('workflow_runs_business_idx').on(t.businessId),
]);

export const workflowJobs = pgTable('workflow_jobs', {
  id: serial('id').primaryKey(),
  bossJobId: text('boss_job_id'),
  jobType: text('job_type').notNull(),
  businessId: text('business_id'),
  campaignId: text('campaign_id'),
  idempotencyKey: text('idempotency_key'),
  /** Nullable for rows created before workflow_job_runs was introduced. */
  runId: uuid('run_id').references(() => workflowJobRuns.id),
  /** Physical successor number within one logical run; nullable for legacy rows. */
  attemptSequence: integer('attempt_sequence'),
  /** Full job payload as enqueued — so a UI retry re-runs the job VERBATIM
   * (projectId/iteration/issues survive), instead of a lossy reconstruction. */
  payload: jsonb('payload'),
  // spec §6: queued | running | succeeded | retry_wait | failed | needs_human | cancelled
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  /** Set with status=retry_wait: when the subscription window is expected back. */
  nextAttemptAt: timestamp('next_attempt_at'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  index('job_biz_idx').on(t.businessId),
  index('job_status_idx').on(t.status),
  index('job_run_idx').on(t.runId),
  uniqueIndex('job_run_sequence_idx').on(t.runId, t.attemptSequence)
    .where(sql`${t.runId} is not null`),
]);

/** Durable audit trail for one-time startup repairs of pre-run job rows. */
export const workflowReconciliationEvents = pgTable('workflow_reconciliation_events', {
  id: serial('id').primaryKey(),
  eventType: text('event_type').notNull(),
  jobType: text('job_type').notNull(),
  idempotencyKey: text('idempotency_key'),
  runId: uuid('run_id').references(() => workflowJobRuns.id),
  attemptId: integer('attempt_id').references(() => workflowJobs.id),
  bossJobId: text('boss_job_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  index('workflow_reconciliation_run_idx').on(t.runId),
  index('workflow_reconciliation_created_idx').on(t.createdAt),
]);

// ─── Enrichment fan-out barrier ─────────────────────────────────────────────

/**
 * One evidence generation fans out into assets + website audit. Scoring may
 * start only after both branches have durably succeeded for the current run.
 */
export const enrichmentRuns = pgTable('enrichment_runs', {
  id: uuid('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id),
  generation: integer('generation').notNull(),
  // native | legacy (bounded compatibility for pre-0017 live branch jobs)
  source: text('source').notNull().default('native'),
  // running | score_enqueued | completed | blocked | superseded
  status: text('status').notNull().default('running'),
  // pending | succeeded | failed | blocked
  assetsStatus: text('assets_status').notNull().default('pending'),
  auditStatus: text('audit_status').notNull().default('pending'),
  blockingReason: text('blocking_reason'),
  scoreEnqueuedAt: timestamp('score_enqueued_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
}, (t) => [
  uniqueIndex('enrichment_runs_business_generation_idx').on(t.businessId, t.generation),
  uniqueIndex('enrichment_runs_current_business_idx')
    .on(t.businessId)
    .where(sql`${t.status} in ('running', 'score_enqueued')`),
  index('enrichment_runs_status_idx').on(t.status),
]);

// ─── Settings (phase E) ──────────────────────────────────────────────────────

/**
 * Key/value store with three kinds of row, distinguished by key prefix:
 *
 *   `imap.cursor`        poller state (phase E) — neither evidence nor business data;
 *   `setting:<KEY>`      operational configuration edited in the UI (/settings);
 *   `heartbeat:<group>`  worker liveness, stamped every 30s for the UI's system panel.
 *
 * Configuration lives here rather than in `.env` by Roman's decision
 * (2026-08-17): a token paste or a dry_run→live flip must take effect live,
 * without editing a file and recreating containers. SPEC §8 is amended
 * accordingly — SECRET values are AES-256-GCM encrypted under
 * `SETTINGS_MASTER_KEY`, which is the one credential that stays in `.env`, so
 * this table on its own is not a credential store. See `src/lib/settings.ts`.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  /** True when `value` is an `enc:v1:<iv>:<tag>:<ct>` envelope, not plaintext. */
  encrypted: boolean('encrypted').notNull().default(false),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  /** 'roman' for a UI edit, 'worker' for a heartbeat. Credential changes are auditable. */
  updatedBy: text('updated_by'),
});
