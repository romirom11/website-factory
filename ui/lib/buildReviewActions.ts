'use server';

/**
 * The three decisions Roman can make about a build the critic rejected.
 *
 * After MAX_QA_ITERATIONS the visual-QA worker parks the project in
 * `needs_human_review`, the business in `needs_review`, and the pipeline stops
 * — by design, so a bad demo is never shipped and the loop never runs forever.
 * What was missing was any way for Roman to END that state. The build was
 * invisible: no preview (it never deployed), and no button.
 *
 * So: SHIP IT (deploy as-is), ONE MORE PASS (his own note becomes a QA issue),
 * or DROP IT. Each one is a state change with an audit trail naming him.
 */

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db, schema } from './db';
import { enqueueJob } from './jobs';
import { factoryFetch } from './factoryApi';
import { transitionBusiness } from './actions';
import type { ActionResult } from './types';
import { closeVisualQaVerdict } from './visualQaDecision';

type SiteProject = typeof schema.siteProjects.$inferSelect;

/**
 * Load the project, or explain why it cannot be acted on.
 *
 * Returns the project OR a message, never both — so every caller is forced to
 * handle "this build is no longer waiting for a decision", which is the case
 * that happens for real when Roman has the page open on two devices.
 */
async function loadReviewable(
  projectId: number,
): Promise<{ project: SiteProject } | { error: string }> {
  const [project] = await db.select().from(schema.siteProjects)
    .where(eq(schema.siteProjects.id, projectId));
  if (!project) return { error: 'Збірку не знайдено' };
  if (project.state !== 'needs_human_review') {
    return { error: `Ця збірка вже не чекає рішення (${project.state})` };
  }
  return { project };
}

/**
 * Open a read-only preview of the rejected build.
 *
 * The factory process owns the files and the demo server, so the UI asks it to
 * mount the workspace `out/` and hands back the URL. It is NOT a rebuild: the
 * GC keeps `out/` for this state precisely so looking at the page costs nothing.
 */
export async function openBuildPreview(projectId: number): Promise<ActionResult & { url?: string }> {
  const found = await loadReviewable(projectId);
  if ('error' in found) return { ok: false, message: found.error };

  const res = await factoryFetch(`/internal/preview/${projectId}`, { method: 'POST' });
  if (!res.ok) {
    return {
      ok: false,
      message: res.message
        || 'Фабрика не відповіла. Перевір, чи запущений сервіс factory (Налаштування → Система).',
    };
  }
  return { ok: true, message: 'Preview відкрито', url: String(res.body?.url ?? '') };
}

/**
 * Ship the demo as it is: Roman overrules the critic.
 *
 * The critic's verdict is advisory once a human has looked at the page — that is
 * the entire point of `needs_human_review`. So this flips the project back to
 * `ready` and enqueues the SAME `deploy-demo` job the QA loop would have. The
 * deploy worker still runs its own health check (HTTP 200, noindex, the
 * business's name in the HTML, a reachable stylesheet), so "as-is" never means
 * "unverified" — a genuinely broken export still fails here.
 */
export async function deployBuildAsIs(projectId: number): Promise<ActionResult> {
  const found = await loadReviewable(projectId);
  if ('error' in found) return { ok: false, message: found.error };
  const { project } = found;

  const [biz] = await db.select().from(schema.businesses)
    .where(eq(schema.businesses.id, project.businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };

  // `deploy-demo` refuses any state other than ready/deployed, so this update is
  // the gate, not a formality. Conditional on the state we read, so two clicks
  // cannot both pass.
  const updated = await db.update(schema.siteProjects)
    .set({ state: 'ready' })
    .where(and(
      eq(schema.siteProjects.id, projectId),
      eq(schema.siteProjects.state, 'needs_human_review'),
    ))
    .returning();
  if (!updated.length) {
    return { ok: false, message: 'Цю збірку щойно вже відправили — другий деплой не створено.' };
  }
  await closeVisualQaVerdict(projectId, 'задеплоїти як є');

  // The business is in `needs_review`; the deploy worker will move it to
  // site_ready itself. Recording the human decision here keeps the audit trail
  // honest about WHO overruled the critic.
  await db.insert(schema.statusHistory).values({
    businessId: project.businessId,
    fromStatus: biz.status,
    toStatus: biz.status,
    reason: `Роман прийняв збірку попри вердикт критика (${project.qaIterations} QA-ітерацій)`,
    actor: 'roman',
  });

  const result = await enqueueJob({
    name: 'deploy-demo',
    businessId: project.businessId,
    campaignId: biz.campaignId,
    idempotencyKey: `deploy-demo:${project.businessId}:${projectId}`,
    data: { projectId },
  });

  revalidatePath('/inbox');
  revalidatePath(`/businesses/${project.businessId}`);

  if (result.kind === 'duplicate') {
    return { ok: false, message: 'Деплой уже стоїть у черзі для цієї збірки.' };
  }
  return { ok: true, message: 'Деплой поставлено в чергу. Коли демо опублікується, воно з’явиться у Вхідних на підтвердження.' };
}

/**
 * One more pass, with Roman's own note as the brief.
 *
 * His note is appended to `QA-ISSUES.md` as a human issue, above the machine
 * ones, and the builder reads that file first on a fix iteration. The iteration
 * counter RESTARTS at 0: MAX_QA_ITERATIONS is a budget per run, and this is a
 * new run that a human authorised — carrying the exhausted counter forward would
 * make the builder fix one thing and immediately hit the cap again.
 */
export async function requestAnotherIteration(input: {
  projectId: number;
  note: string;
}): Promise<ActionResult> {
  const note = input.note.trim();
  if (!note) {
    return { ok: false, message: 'Напиши, що саме виправити — без цього ітерація повторить те саме.' };
  }

  const found = await loadReviewable(input.projectId);
  if ('error' in found) return { ok: false, message: found.error };
  const { project } = found;

  const [biz] = await db.select().from(schema.businesses)
    .where(eq(schema.businesses.id, project.businessId));
  if (!biz) return { ok: false, message: 'Бізнес не знайдено' };

  // Ask the factory to write the note into the workspace. It owns the files;
  // the UI container does not necessarily see the same paths.
  const written = await factoryFetch(`/internal/qa-note/${input.projectId}`, {
    method: 'POST',
    body: { note },
  });
  if (!written.ok) {
    return {
      ok: false,
      message: written.message || 'Не вдалося записати нотатку у воркспейс — ітерацію не запущено.',
    };
  }

  const updated = await db.update(schema.siteProjects)
    .set({ state: 'building', qaIterations: 0 })
    .where(and(
      eq(schema.siteProjects.id, input.projectId),
      eq(schema.siteProjects.state, 'needs_human_review'),
    ))
    .returning();
  if (!updated.length) {
    return { ok: false, message: 'Цю збірку щойно вже відправили в роботу.' };
  }
  await closeVisualQaVerdict(input.projectId, 'ще одна ітерація');

  // The business goes BACK to `site_in_progress`, not just into the audit log.
  // Leaving it in `needs_review` kept the «Потрібна твоя увага» badge and the
  // stale «критик не прийняв за 3 спроби» header lit for the whole hour-long
  // rebuild (Roman, 2026-08-23: «Де тут мені шо робить?» — ніде, збірка йшла).
  // transitionBusiness also rewrites status_reason, so the header now says
  // what is actually happening. When the new run's QA fails again, visual-qa
  // moves it back to needs_review with a fresh reason, exactly as before.
  await transitionBusiness(
    project.businessId,
    'site_in_progress',
    `Роман замовив ще одну ітерацію: ${note.slice(0, 200)}`,
  );

  // `iteration: 1` marks this as a FIX run, so the builder edits the existing
  // workspace instead of wiping it and rebuilding from the design contract —
  // which would throw away everything the previous three iterations got right.
  const result = await enqueueJob({
    name: 'build-site',
    businessId: project.businessId,
    campaignId: biz.campaignId,
    idempotencyKey: `build-site:${project.businessId}:${input.projectId}:roman:${Date.now()}`,
    data: {
      projectId: input.projectId,
      iteration: 1,
      issues: [`[high/roman] ${note}`],
    },
  });

  revalidatePath('/inbox');
  revalidatePath(`/businesses/${project.businessId}`);

  if (result.kind === 'duplicate') return { ok: false, message: 'Збірка вже стоїть у черзі.' };
  return { ok: true, message: 'Ітерацію поставлено в чергу. Коли збірка пройде QA, вона повернеться у Вхідні.' };
}

/** Drop this lead: the demo is not worth more work. */
export async function rejectBuild(input: {
  projectId: number;
  reason: string;
}): Promise<ActionResult> {
  const found = await loadReviewable(input.projectId);
  if ('error' in found) return { ok: false, message: found.error };
  const { project } = found;

  const reason = input.reason.trim() || 'Роман відхилив демо після рев’ю';

  await db.update(schema.siteProjects)
    .set({ state: 'failed' })
    .where(eq(schema.siteProjects.id, input.projectId));
  await closeVisualQaVerdict(input.projectId, 'відхилити бізнес');

  const moved = await transitionBusiness(project.businessId, 'rejected', reason);
  revalidatePath('/inbox');
  revalidatePath(`/businesses/${project.businessId}`);
  if (!moved.ok) return moved;
  return { ok: true, message: 'Бізнес відхилено. Evidence лишається в базі.' };
}
