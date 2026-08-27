'use server';

/**
 * Server actions = every mutation Roman can make from the UI.
 *
 * These carry the same hard rules as the workers, because the UI is the thing
 * that triggers a send:
 *  - Approve writes an `approvals` row and enqueues exactly one `send-outreach`
 *    whose idempotency key is derived from the approval id. A second Approve on
 *    an already-decided approval is refused HERE, and the outreach worker's
 *    unique index refuses it again. Two independent locks, on purpose.
 *  - Manual status changes are recorded with actor 'roman' and a reason, so
 *    status_history stays a real audit trail (SPEC §5).
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db, schema } from './db';
import { enqueueJob, type JobName } from './jobs';
import { sendIdempotencyKey, followupIdempotencyKey, isManualChannel, deepLinkFor } from './keys';
import {
  BUILDABLE_STATUSES, BUILD_POLICY_LABELS, buildJobPriority, isActiveJobStatus,
  isActiveProjectState, normalizeBuildPolicy,
} from './buildPolicy';
import { CLOSED_STATUSES, isSocialChannel, socialsButtonState } from './socials';
import { humanStatus, reviewAsk } from './humanStatus';
import { stageName } from './stageNames';
import type { ActionResult } from './types';
import { retryFailedJob, stopFailedBuild } from './buildFailureDecision';
import { isJobName } from '@factory/jobDefinitions';

// ─── Approvals ───────────────────────────────────────────────────────────────

/**
 * Approve outreach for a business.
 *
 * Exactly-once is enforced by decision state: the UPDATE only matches an
 * approval whose decision IS NULL, so two concurrent clicks mean one UPDATE
 * matches a row and the other matches nothing — and only the winner enqueues.
 */
export async function approveOutreach(input: {
  approvalId: number;
  channel: string;
  toAddress: string;
  subject: string | null;
  body: string;
}): Promise<ActionResult> {
  const [approval] = await db.select().from(schema.approvals)
    .where(eq(schema.approvals.id, input.approvalId));
  if (!approval) return { ok: false, message: 'Approval не знайдено' };
  if (approval.decision) {
    return { ok: false, message: `Вже вирішено раніше: ${approval.decision}. Другий send неможливий.` };
  }
  if (!input.channel || !input.toAddress) {
    return { ok: false, message: 'Не обрано канал або адресу — відправляти нікуди' };
  }
  if (!input.body.trim()) {
    return { ok: false, message: 'Порожній текст повідомлення' };
  }

  const payload = {
    ...(approval.payload as Record<string, unknown> ?? {}),
    draft: {
      channel: input.channel,
      toAddress: input.toAddress,
      subject: input.subject,
      body: input.body,
    },
    // Record what Roman actually approved, distinct from what was proposed.
    approvedAt: new Date().toISOString(),
  };

  // Conditional update = the lock. Losing click updates zero rows.
  const updated = await db.update(schema.approvals)
    .set({ decision: 'approved', decidedBy: 'roman', decidedAt: new Date(), payload })
    .where(and(eq(schema.approvals.id, input.approvalId), isNull(schema.approvals.decision)))
    .returning();

  if (!updated.length) {
    return { ok: false, message: 'Це approval вже вирішене іншим кліком — другий send не створено.' };
  }

  await transitionBusiness(approval.businessId, 'outreach_approved', `approval #${approval.id}`);

  await enqueueJob({
    name: 'send-outreach',
    businessId: approval.businessId,
    idempotencyKey: sendIdempotencyKey(approval.id),
    data: { approvalId: approval.id },
  });

  revalidatePath('/inbox');
  revalidatePath(`/businesses/${approval.businessId}`);

  if (isManualChannel(input.channel)) {
    return {
      ok: true,
      message: `Затверджено. ${input.channel} — ручний канал: відкрий deep link, встав текст, відправ і підтверди.`,
      manual: {
        channel: input.channel,
        deepLink: deepLinkFor(input.channel, input.toAddress, input.body),
        text: input.body,
        approvalId: approval.id,
      },
    };
  }
  return { ok: true, message: 'Затверджено. Send поставлено в чергу (рівно один).' };
}

export async function rejectOutreach(input: { approvalId: number; reason: string }): Promise<ActionResult> {
  const [approval] = await db.select().from(schema.approvals)
    .where(eq(schema.approvals.id, input.approvalId));
  if (!approval) return { ok: false, message: 'Approval не знайдено' };
  if (approval.decision) return { ok: false, message: `Вже вирішено: ${approval.decision}` };

  const updated = await db.update(schema.approvals)
    .set({ decision: 'rejected', decidedBy: 'roman', decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, input.approvalId), isNull(schema.approvals.decision)))
    .returning();
  if (!updated.length) return { ok: false, message: 'Вже вирішене іншим кліком' };

  await transitionBusiness(approval.businessId, 'rejected', input.reason || `approval #${approval.id} rejected`);
  revalidatePath('/inbox');
  return { ok: true, message: 'Відхилено.' };
}

/**
 * Roman sent a manual-channel message by hand and confirms it.
 * Flips the pending outreach row to sent, moves the business to contacted and
 * schedules follow-ups. Idempotent: a second confirmation changes nothing.
 */
export async function confirmManualSent(input: { approvalId: number }): Promise<ActionResult> {
  const key = sendIdempotencyKey(input.approvalId);
  const [msg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.idempotencyKey, key));
  if (!msg) {
    return { ok: false, message: 'Повідомлення ще не створене воркером — зачекай секунду і онови.' };
  }
  if (msg.state !== 'manual_pending') {
    return { ok: true, message: `Вже позначено як ${msg.state} — повторно нічого не робимо.` };
  }

  await db.update(schema.outreachMessages)
    .set({ state: 'sent', sentAt: new Date() })
    .where(and(eq(schema.outreachMessages.id, msg.id), eq(schema.outreachMessages.state, 'manual_pending')));
  await db.insert(schema.outreachEvents).values({
    businessId: msg.businessId, messageId: msg.id, event: 'sent',
    detail: { channel: msg.channel, manualConfirmation: true, actor: 'roman' },
  });
  await transitionBusiness(msg.businessId, 'contacted', `${msg.channel} відправлено вручну`);
  await db.insert(schema.deals).values({ businessId: msg.businessId, state: 'contacted' }).onConflictDoNothing();

  // Follow-ups, same keying as the worker.
  const followupDays = (process.env.FOLLOWUP_SCHEDULE_DAYS ?? '3,7').split(',').map(Number);
  for (let i = 0; i < followupDays.length; i++) {
    await enqueueJob({
      name: 'send-followup',
      businessId: msg.businessId,
      idempotencyKey: followupIdempotencyKey(input.approvalId, i + 1),
      data: { followupIndex: i + 1, approvalId: input.approvalId, channel: msg.channel },
      startAfterSeconds: followupDays[i] * 24 * 3600,
    });
  }

  revalidatePath('/inbox');
  revalidatePath(`/businesses/${msg.businessId}`);
  return { ok: true, message: 'Записано як відправлене вручну, follow-up заплановані.' };
}

// ─── Business-level manual actions ───────────────────────────────────────────

/**
 * Manual status change. Always actor='roman' with a reason, and always forced:
 * the point of a manual override is to go where the state machine would not.
 */
export async function transitionBusiness(
  businessId: string, to: string, reason: string,
): Promise<ActionResult> {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };
  if (biz.status === to) return { ok: true, message: `Вже в статусі ${to}` };

  await db.transaction(async (tx) => {
    await tx.update(schema.businesses)
      .set({ status: to, statusReason: reason, updatedAt: new Date() })
      .where(eq(schema.businesses.id, businessId));
    await tx.insert(schema.statusHistory).values({
      businessId, fromStatus: biz.status, toStatus: to, reason, actor: 'roman',
    });
  });

  revalidatePath(`/businesses/${businessId}`);
  revalidatePath('/businesses');
  return { ok: true, message: `${biz.status} → ${to}` };
}

/**
 * Claim one operator decision from an exact current state.
 *
 * Review cards can be open in two tabs. A plain read followed by the forced
 * transition above lets both buttons win; this conditional transition makes
 * Build, Recollect, and Close mutually exclusive without inventing a lock row.
 */
async function transitionBusinessFrom(
  businessId: string,
  from: string,
  to: string,
  reason: string,
): Promise<ActionResult> {
  const moved = await db.transaction(async (tx) => {
    const changed = await tx.update(schema.businesses)
      .set({ status: to, statusReason: reason, updatedAt: new Date() })
      .where(and(
        eq(schema.businesses.id, businessId),
        eq(schema.businesses.status, from),
      ))
      .returning({ id: schema.businesses.id });
    if (!changed.length) return false;
    await tx.insert(schema.statusHistory).values({
      businessId, fromStatus: from, toStatus: to, reason, actor: 'roman',
    });
    return true;
  });

  revalidatePath(`/businesses/${businessId}`);
  revalidatePath('/businesses');
  return moved
    ? { ok: true, message: `${from} → ${to}` }
    : { ok: false, message: 'Це рішення щойно вже прийняли в іншій вкладці.' };
}

/**
 * Форма-обгортка для manual transition (щоб не передавати обʼєкт з клієнта).
 *
 * Returns a result rather than void: every action in the console reports what
 * it did through a toast (Roman, 2026-08-22 — «нажав змінити статус і хз,
 * спрацювало чи ні»), and a `Promise<void>` has nothing to report. The message
 * names the state in HIS words, not the enum: `humanStatus` is what the rest of
 * the console prints, so the toast and the card cannot say different things.
 */
export async function forceStatusAction(formData: FormData): Promise<ActionResult> {
  const businessId = String(formData.get('businessId') ?? '');
  const to = String(formData.get('to') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!businessId || !to) return { ok: false, message: 'Не вибрано бізнес або стан' };

  const moved = await transitionBusiness(businessId, to, reason || 'ручна зміна статусу Романом');
  if (!moved.ok) return moved;
  return { ok: true, message: `Стан змінено на «${humanStatus(to).text}»` };
}

/** Permanent opt-out (SPEC §8): checked again at send time by the worker. */
export async function markDoNotContact(formData: FormData): Promise<ActionResult> {
  const businessId = String(formData.get('businessId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || 'позначено вручну в UI';
  if (!businessId) return { ok: false, message: 'Не вибрано бізнес' };

  await db.insert(schema.doNotContact)
    .values({ matchType: 'business_id', value: businessId, reason })
    .onConflictDoNothing();

  // Also block the concrete addresses, so a re-discovered duplicate stays blocked.
  const contacts = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.businessId, businessId));
  for (const c of contacts) {
    const matchType = c.channel === 'email' ? 'email'
      : ['phone', 'whatsapp', 'viber'].includes(c.channel) ? 'phone' : null;
    if (!matchType) continue;
    await db.insert(schema.doNotContact)
      .values({ matchType, value: c.value, reason: `do_not_contact ${businessId}` })
      .onConflictDoNothing();
  }

  await transitionBusiness(businessId, 'do_not_contact', reason);

  // Named by its consequence, and it says how many addresses went with the
  // business — that is the part a person cannot see from the card afterwards.
  return {
    ok: true,
    message: contacts.length
      ? `Заблоковано назавжди — бізнес і ${contacts.length} його адрес`
      : 'Заблоковано назавжди',
  };
}

/** Re-run a pipeline stage for one business. */
export async function reenqueueStage(formData: FormData): Promise<ActionResult> {
  const businessId = String(formData.get('businessId') ?? '');
  const requestedJob = String(formData.get('job') ?? '');
  if (!businessId || !isJobName(requestedJob)) return { ok: false, message: 'Не вибрано коректний крок' };
  const job: JobName = requestedJob;
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };
  // A fresh key every time on purpose: this button means "run it again NOW",
  // and a stable key would make the second press a silent no-op.
  const result = await enqueueJob({
    name: job, businessId, campaignId: biz.campaignId,
    idempotencyKey: `${job}:${businessId}:${Date.now()}`,
  });
  revalidatePath(`/businesses/${businessId}`);
  revalidatePath('/settings', 'layout');

  if (result.kind === 'duplicate') return { ok: false, message: `Крок «${stageName(job)}» уже стоїть у черзі` };
  return { ok: true, message: `Крок «${stageName(job)}» поставлено в чергу` };
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/**
 * Retry a failed job under the SAME idempotency key, so a retry of a send can
 * never become a second send: the outreach row already exists under that key.
 *
 * `workflow_jobs` is an ATTEMPT LOG — one row per attempt, which is why a real
 * business carries up to nine rows under one key. `enqueueJob` therefore writes
 * the new attempt's row itself, and the retried row must be CLOSED, not flipped
 * back to `queued`.
 *
 * Flipping it (what this did before) left two rows in a live state for one
 * queue entry: one real, one phantom that no worker would ever pick up. That is
 * precisely the ghost that made the queue widget report work in flight which
 * did not exist (sweep P0-3), and the build button reads this same table to
 * decide "a build is already running" — so a phantom `queued` row blocks the
 * business indefinitely. Caught by `pnpm e2e`, group 6.
 */
export async function retryJob(formData: FormData): Promise<ActionResult> {
  const id = Number(formData.get('jobId'));
  if (!id) return { ok: false, message: 'Не вибрано крок' };
  const outcome = await retryFailedJob(id);
  revalidatePath('/settings', 'layout');
  revalidatePath('/inbox');
  if (outcome === 'missing') return { ok: false, message: 'Цей крок уже не знайти.' };
  if (outcome === 'resolved') return { ok: false, message: 'Цей крок щойно вже вирішили.' };
  return {
    ok: true,
    message: outcome === 'queued'
      ? 'Поставлено в чергу — фабрика спробує ще раз.'
      : 'Цей крок уже стоїть у черзі.',
  };
}

/**
 * Same retry, called from a button that reports back instead of a <form>.
 *
 * The inbox shows the outcome in place rather than reloading the page under
 * Roman's finger, so it needs a message; the form wrapper above stays for the
 * settings-side jobs table.
 *
 * `ActionResult` rather than a bare string, so the toast can tell "queued" from
 * "there is nothing here to retry" — as a string both were success-green.
 */
export async function retryJobAction(jobId: number): Promise<ActionResult> {
  const outcome = await retryFailedJob(jobId);
  if (outcome === 'missing') return { ok: false, message: 'Цей крок уже не знайти.' };
  if (outcome === 'resolved') return { ok: false, message: 'Цей крок щойно вже вирішили.' };

  revalidatePath('/inbox');
  revalidatePath('/settings', 'layout');
  return {
    ok: true,
    message: outcome === 'queued'
      ? 'Поставлено в чергу — фабрика спробує ще раз.'
      : 'Цей крок уже стоїть у черзі.',
  };
}

/**
 * Stop a dead build without rejecting its business.
 *
 * The failed attempt is history, the half-built project becomes `failed`, and
 * the business returns to `production_ready` so Roman may build it again later.
 * This is the second honest ending of a failed-build card; dismissing only the
 * job row would leave the business stuck in `site_in_progress` forever.
 */
export async function stopFailedBuildAction(jobId: number): Promise<ActionResult> {
  const result = await stopFailedBuild(jobId);
  revalidatePath('/inbox');
  if (result.businessId) revalidatePath(`/businesses/${result.businessId}`);
  revalidatePath('/businesses');
  return { ok: result.ok, message: result.message };
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

export async function createCampaign(formData: FormData): Promise<ActionResult> {
  const city = String(formData.get('city') ?? '').trim();
  const niche = String(formData.get('niche') ?? '').trim();
  const country = String(formData.get('country') ?? 'GR').trim();
  const language = String(formData.get('language') ?? 'el').trim();
  const queries = String(formData.get('queries') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const targetCount = Number(formData.get('targetCount') ?? 50);
  const lat = Number(formData.get('lat') ?? 0);
  const lng = Number(formData.get('lng') ?? 0);
  const radiusKm = Number(formData.get('radiusKm') ?? 10);
  // Build policy is chosen up front: it decides which production_ready businesses
  // the factory starts building for on its own. Default is "only those with no
  // site of their own" (Roman's rule), and it stays editable on this page.
  const autoBuild = normalizeBuildPolicy(String(formData.get('autoBuild') ?? ''));
  if (!city || !niche || !queries.length) {
    return { ok: false, message: 'Потрібні місто, ніша і хоча б один пошуковий запит' };
  }

  const slug = `${country}-${city}-${niche}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `${slug}-${new Date().toISOString().slice(0, 7)}`;

  // `onConflictDoNothing` means a repeat of this month's city+niche is a no-op,
  // and the operator has to be told that rather than shown a success.
  const created = await db.insert(schema.campaigns).values({
    id, country, city, niche, language, queries,
    geofence: { lat, lng, radiusKm },
    targetCount,
    autoBuild,
    mode: process.env.FACTORY_MODE === 'live' ? 'live' : 'dry_run',
    status: 'running',
  }).onConflictDoNothing().returning({ id: schema.campaigns.id });

  if (!created.length) {
    return { ok: false, message: `Кампанія «${id}» уже існує — нову не створено` };
  }

  await enqueueJob({ name: 'discover', campaignId: id, idempotencyKey: `discover:${id}` });
  revalidatePath('/campaigns');
  return { ok: true, message: `Кампанію «${city} · ${niche}» створено, пошук бізнесів поставлено в чергу` };
}

// ─── Deals ───────────────────────────────────────────────────────────────────

export async function updateDealStage(formData: FormData): Promise<ActionResult> {
  const businessId = String(formData.get('businessId') ?? '');
  const state = String(formData.get('state') ?? '');
  if (!businessId || !state) return { ok: false, message: 'Не вибрано етап' };

  await db.insert(schema.deals).values({ businessId, state })
    .onConflictDoUpdate({
      target: schema.deals.businessId,
      set: { state, updatedAt: new Date() },
    });

  // Keep the business status in step with the deal for the stages that mirror.
  if (['replied', 'meeting', 'proposal', 'won', 'lost'].includes(state)) {
    await transitionBusiness(businessId, state, `deal stage → ${state} (вручну)`);
  }
  revalidatePath('/inbox');
  revalidatePath(`/businesses/${businessId}`);
  return { ok: true, message: `Етап розмови: «${humanStatus(state).text}»` };
}

// ─── Funnel counts (used by several pages) ───────────────────────────────────

export async function funnelCounts(): Promise<Array<{ campaignId: string; status: string; n: number }>> {
  const rows = await db.execute(sql`
    select campaign_id as "campaignId", status, count(*)::int as n
    from businesses group by campaign_id, status
  `);
  return rows.rows as Array<{ campaignId: string; status: string; n: number }>;
}

// ─── Build policy: who gets a demo site built ────────────────────────────────

/**
 * Start a demo build for one business, from the UI button.
 *
 * This is the manual counterpart of the router's policy gate: the campaign's
 * `auto_build` decides what the FACTORY does on its own, this decides what
 * ROMAN does deliberately — so it does not consult the policy at all. What it
 * does enforce is everything else:
 *
 *  - only `production_ready` (or `needs_review` with no open hard gaps, which
 *    is first transitioned by 'roman' so the audit trail names the decider);
 *  - exactly-once: a business whose newest site_project is still in flight, or
 *    that already has a queued/running build job, is refused rather than given
 *    a second builder working the same directory.
 *
 * The state machine is untouched: `production_ready → site_in_progress` is
 * still done by the content-and-design worker, never here.
 */
export async function startDemoBuild(businessId: string): Promise<ActionResult> {
  const [biz] = await db.select().from(schema.businesses)
    .where(eq(schema.businesses.id, businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };

  if (!BUILDABLE_STATUSES.has(biz.status)) {
    return { ok: false, message: `${biz.name}: статус ${biz.status} — збірка не запускається звідси` };
  }

  // Already building? Refuse. Two builders in one workspace is the failure mode
  // this check exists for.
  const [project] = await db.select().from(schema.siteProjects)
    .where(eq(schema.siteProjects.businessId, businessId))
    .orderBy(desc(schema.siteProjects.createdAt)).limit(1);
  if (isActiveProjectState(project?.state)) {
    return { ok: false, message: `${biz.name}: збірка вже йде (${project!.state})` };
  }

  const [job] = await db.select().from(schema.workflowJobs)
    .where(and(
      eq(schema.workflowJobs.businessId, businessId),
      inArray(schema.workflowJobs.jobType, ['content-and-design', 'build-site']),
    ))
    .orderBy(desc(schema.workflowJobs.createdAt)).limit(1);
  if (isActiveJobStatus(job?.status)) {
    return { ok: false, message: `${biz.name}: job уже в черзі (${job!.status})` };
  }

  const [gaps] = await db.select({ n: sql<number>`count(*)` }).from(schema.productionGaps)
    .where(and(
      eq(schema.productionGaps.businessId, businessId),
      eq(schema.productionGaps.resolved, false),
      eq(schema.productionGaps.blockerLevel, 'hard'),
    ));
  const openGaps = Number(gaps?.n ?? 0);

  if (biz.status === 'needs_review') {
    // A demo built over an unresolved hard gap would have to invent the missing
    // material, which the factory does not do (SPEC §5). Refuse, don't paper over.
    if (openGaps > 0) {
      return { ok: false, message: `${biz.name}: ${openGaps} незакритих gaps — спершу закрий їх` };
    }
    const moved = await transitionBusinessFrom(
      businessId, 'needs_review', 'production_ready',
      'ручний запуск збірки з UI: gaps закриті',
    );
    if (!moved.ok) return moved;
  }

  const verdict = await latestVerdict(businessId);

  // Stable idempotency key: a second click resolves to the canonical active
  // run, and the checks above already refuse it even earlier.
  const result = await enqueueJob({
    name: 'content-and-design',
    businessId,
    campaignId: biz.campaignId,
    idempotencyKey: `content-and-design:${businessId}`,
    priority: buildJobPriority({ latestVerdict: verdict, score: biz.score }),
  });

  revalidatePath('/businesses');
  revalidatePath(`/businesses/${businessId}`);
  revalidatePath('/settings', 'layout');

  if (result.kind === 'duplicate') {
    return { ok: false, message: `${biz.name}: такий job уже активний у черзі` };
  }
  return { ok: true, message: `${biz.name}: збірка демо поставлена в чергу` };
}

/** Latest audit verdict, or null when the business was never audited. */
async function latestVerdict(businessId: string): Promise<string | null> {
  const [row] = await db.select({ verdict: schema.websiteAudits.verdict })
    .from(schema.websiteAudits)
    .where(eq(schema.websiteAudits.businessId, businessId))
    .orderBy(desc(schema.websiteAudits.auditedAt)).limit(1);
  return row?.verdict ?? null;
}

/**
 * Bulk build over the ids the operator currently has selected.
 *
 * Deliberately sequential and per-business fault-isolated: one refusal (wrong
 * status, build already running) must not stop the rest, exactly like a failing
 * business never stops a campaign.
 */
export async function startDemoBuildBulk(businessIds: string[]): Promise<ActionResult> {
  const ids = [...new Set(businessIds.filter(Boolean))];
  if (!ids.length) return { ok: false, message: 'Нічого не обрано' };

  const results = await Promise.all(ids.map(async (id) => {
    try {
      return await startDemoBuild(id);
    } catch (err) {
      return { ok: false, message: `${id}: ${String(err)}` } satisfies ActionResult;
    }
  }));

  const queued = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => !r.ok);
  const detail = skipped.length ? ` Пропущено ${skipped.length}: ${skipped.map((s) => s.message).join('; ')}` : '';
  return {
    ok: queued > 0,
    message: `Поставлено в чергу: ${queued} з ${ids.length}.${detail}`,
  };
}

/** Finish a `needs_review` fact/verdict card without hiding the alternatives. */
export async function resolveBusinessReviewAction(input: {
  businessId: string;
  decision: 'recollect_facts' | 'close';
}): Promise<ActionResult> {
  const [biz] = await db.select({
    id: schema.businesses.id,
    name: schema.businesses.name,
    status: schema.businesses.status,
    statusReason: schema.businesses.statusReason,
    campaignId: schema.businesses.campaignId,
  }).from(schema.businesses)
    .where(eq(schema.businesses.id, input.businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };
  if (biz.status !== 'needs_review') {
    return { ok: false, message: `${biz.name}: це рішення вже не актуальне (${humanStatus(biz.status).text})` };
  }

  let ask = reviewAsk(biz.statusReason);
  if (ask === 'verdict') ask = reviewAsk(biz.statusReason, await latestVerdict(biz.id));
  if (ask !== 'fact_check' && ask !== 'verdict') {
    return { ok: false, message: `${biz.name}: ця картка не просить такого рішення` };
  }

  if (input.decision === 'close') {
    const moved = await transitionBusinessFrom(
      biz.id, 'needs_review', 'closed',
      'Роман вирішив не брати бізнес у роботу після перевірки',
    );
    revalidatePath('/inbox');
    if (!moved.ok) return moved;
    return { ok: true, message: `${biz.name}: закрито без статусу «Відхилено» і без контакту` };
  }

  const [latest] = await db.select({ status: schema.workflowJobs.status })
    .from(schema.workflowJobs)
    .where(and(
      eq(schema.workflowJobs.businessId, biz.id),
      eq(schema.workflowJobs.jobType, 'enrich'),
    ))
    .orderBy(desc(schema.workflowJobs.createdAt))
    .limit(1);
  if (isActiveJobStatus(latest?.status)) {
    const moved = await transitionBusinessFrom(
      biz.id, 'needs_review', 'enriching', 'повторний збір фактів уже запущено Романом',
    );
    revalidatePath('/inbox');
    if (!moved.ok) return moved;
    return { ok: true, message: `${biz.name}: факти вже перезбираються` };
  }

  const claimReason = 'Роман попросив заново зібрати й перевірити факти';
  const moved = await transitionBusinessFrom(
    biz.id, 'needs_review', 'enriching', claimReason,
  );
  if (!moved.ok) return moved;

  let result: Awaited<ReturnType<typeof enqueueJob>>;
  try {
    result = await enqueueJob({
      name: 'enrich',
      businessId: biz.id,
      campaignId: biz.campaignId,
      idempotencyKey: `enrich:${biz.id}:roman`,
    });
  } catch (error) {
    await transitionBusinessFrom(
      biz.id,
      'enriching',
      'needs_review',
      biz.statusReason ?? 'повторний збір фактів не вдалося запустити',
    );
    throw error;
  }

  revalidatePath('/inbox');
  if (result.kind === 'duplicate') return { ok: true, message: `${biz.name}: повторний збір уже стоїть у черзі` };
  return { ok: true, message: `${biz.name}: заново збираю факти й джерела` };
}

/** Change a campaign's build policy. Affects future transitions only. */
export async function setCampaignBuildPolicy(formData: FormData): Promise<ActionResult> {
  const campaignId = String(formData.get('campaignId') ?? '');
  const policy = normalizeBuildPolicy(String(formData.get('autoBuild') ?? ''));
  if (!campaignId) return { ok: false, message: 'Не вибрано кампанію' };
  await db.update(schema.campaigns)
    .set({ autoBuild: policy })
    .where(eq(schema.campaigns.id, campaignId));
  revalidatePath('/campaigns');
  revalidatePath('/businesses');
  return { ok: true, message: `Політика збірки: ${BUILD_POLICY_LABELS[policy]}` };
}

// ─── Social discovery: «Дошукати соцмережі» ──────────────────────────────────

/**
 * Queue the social-discovery step for one business.
 *
 * Deliberately NOT a re-run of `enrich`: that would delete and rebuild every
 * fact of a business whose demo may be building right now. This job only adds
 * sources and contacts, and never touches the status.
 *
 * The idempotency key is stable per business, so a second click resolves to the
 * canonical active run — the same durable lock the build button relies on —
 * and is reported rather than silently treated as a new run.
 */
export async function startSocialsDiscovery(businessId: string): Promise<ActionResult> {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };

  const [job] = await db.select().from(schema.workflowJobs)
    .where(and(
      eq(schema.workflowJobs.businessId, businessId),
      eq(schema.workflowJobs.jobType, 'enrich-socials'),
    ))
    .orderBy(desc(schema.workflowJobs.createdAt)).limit(1);

  const contacts = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.businessId, businessId));
  const verifiedPlatforms = contacts.filter((c) => c.verified).map((c) => c.channel);

  // `biz.status` is passed so a CLOSED business (rejected/lost/do_not_contact)
  // is refused here too, not just greyed out in the list — a bulk run used to
  // enqueue enrich-socials for a rejected business (sweep P1-13).
  const state = socialsButtonState({
    verifiedPlatforms, activeJobStatus: job?.status, status: biz.status,
  });
  if (!state.enabled) return { ok: false, message: `${biz.name}: ${state.hint}` };

  const result = await enqueueJob({
    name: 'enrich-socials',
    businessId,
    campaignId: biz.campaignId,
    idempotencyKey: `enrich-socials:${businessId}`,
  });

  revalidatePath(`/businesses/${businessId}`);
  revalidatePath('/businesses');
  revalidatePath('/settings', 'layout');

  if (result.kind === 'duplicate') return { ok: false, message: `${biz.name}: такий job уже активний у черзі` };
  return { ok: true, message: `${biz.name}: пошук соцмереж поставлено в чергу` };
}

// ─── Identity refresh: «Оновити айдентику» ───────────────────────────────────

/**
 * Re-run logo hunting, photo mining and palette extraction for one business.
 *
 * Why a separate button rather than folding it into «Дошукати соцмережі»: this
 * one makes NO network requests to anybody. It mines the captures already in
 * object storage with the scored logo hunter, which is what re-labels a
 * business whose "logo" is actually a partner brand off its own supplier strip.
 * That makes it safe to press on anything, at any time, including a business
 * whose demo is already deployed — it adds assets and rewrites `brand.*`, and
 * touches neither status nor any other fact.
 *
 * It explicitly does NOT rebuild the demo. Collecting a better logo does not
 * entitle anything to start a build; that stays Roman's button.
 */
export async function refreshBrandIdentity(businessId: string): Promise<ActionResult> {
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };

  // A closed business is not worth spending the worker on, and enqueueing for
  // one is the bug sweep P1-13 fixed for social discovery.
  if (CLOSED_STATUSES.has(biz.status)) {
    return { ok: false, message: `${biz.name}: бізнес закритий (${biz.status})` };
  }

  const result = await enqueueJob({
    name: 'refresh-brand',
    businessId,
    campaignId: biz.campaignId,
    idempotencyKey: `refresh-brand:${businessId}`,
  });

  revalidatePath(`/businesses/${businessId}`);
  revalidatePath('/businesses');

  if (result.kind === 'duplicate') return { ok: false, message: `${biz.name}: оновлення айдентики вже в черзі` };
  return { ok: true, message: `${biz.name}: оновлення айдентики поставлено в чергу` };
}

/**
 * Bulk version over the ids currently selected in the funnel.
 *
 * Sequentially fault-isolated like the bulk build: one refusal (already has
 * both, job in flight) must never stop the rest.
 */
export async function startSocialsDiscoveryBulk(businessIds: string[]): Promise<ActionResult> {
  const ids = [...new Set(businessIds.filter(Boolean))];
  if (!ids.length) return { ok: false, message: 'Нічого не обрано' };

  const results = await Promise.all(ids.map(async (id) => {
    try {
      return await startSocialsDiscovery(id);
    } catch (err) {
      return { ok: false, message: `${id}: ${String(err)}` } satisfies ActionResult;
    }
  }));

  const queued = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => !r.ok);
  const detail = skipped.length
    ? ` Пропущено ${skipped.length}: ${skipped.map((s) => s.message).join('; ')}`
    : '';
  return {
    ok: queued > 0,
    message: `Пошук соцмереж у черзі: ${queued} з ${ids.length}.${detail}`,
  };
}

/**
 * Roman confirms an unverified social candidate found by the matcher.
 *
 * `verified_by` is what distinguishes this from a strong automatic match: the
 * flag alone would lose the fact that a HUMAN decided it. The evidence itself
 * (`source_id` → the captured profile page) is untouched — confirming does not
 * create a fact, it endorses one that already has a source.
 */
export async function verifySocialContact(formData: FormData): Promise<ActionResult> {
  const contactId = Number(formData.get('contactId'));
  if (!contactId) return { ok: false, message: 'Не вибрано контакт' };
  const [contact] = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.id, contactId));
  if (!contact) return { ok: false, message: 'Контакт не знайдено' };

  await db.update(schema.businessContacts)
    .set({
      verified: true,
      verifiedBy: 'roman',
      verifiedNote: String(formData.get('note') ?? '').trim() || null,
    })
    .where(eq(schema.businessContacts.id, contactId));

  // Once a social profile is confirmed, the "we could not confirm one" gap is
  // no longer true.
  if (isSocialChannel(contact.channel)) {
    await db.update(schema.productionGaps).set({ resolved: true }).where(and(
      eq(schema.productionGaps.businessId, contact.businessId),
      eq(schema.productionGaps.gap, 'socials_unresolved'),
      eq(schema.productionGaps.resolved, false),
    ));
  }

  revalidatePath(`/businesses/${contact.businessId}`);
  revalidatePath('/businesses');
  return { ok: true, message: `${contact.channel} підтверджено — тепер це доведений контакт` };
}

/**
 * Roman rejects a candidate: the CONTACT row goes, the EVIDENCE stays.
 *
 * Deleting the captured profile page too would erase the record of what was
 * checked and rejected — the thing that makes a later "why did you miss X?"
 * answerable. Only an unverified row may be deleted, so a click can never
 * destroy a confirmed contact.
 */
export async function rejectSocialContact(formData: FormData): Promise<ActionResult> {
  const contactId = Number(formData.get('contactId'));
  if (!contactId) return { ok: false, message: 'Не вибрано контакт' };
  const [contact] = await db.select().from(schema.businessContacts)
    .where(eq(schema.businessContacts.id, contactId));
  if (!contact) return { ok: false, message: 'Контакт не знайдено' };
  if (contact.verified) {
    return { ok: false, message: 'Цей контакт уже підтверджений — видалити його звідси не можна' };
  }

  await db.delete(schema.businessContacts)
    .where(and(
      eq(schema.businessContacts.id, contactId),
      eq(schema.businessContacts.verified, false),
    ));

  revalidatePath(`/businesses/${contact.businessId}`);
  revalidatePath('/businesses');
  return { ok: true, message: `${contact.channel} прибрано зі списку. Докази лишились у базі.` };
}
