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

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db, schema } from './db';
import { factoryFetch } from './factoryApi';
import type { ActionResult } from './types';

type SiteProject = typeof schema.siteProjects.$inferSelect;
type BuildReviewDecision = 'deploy_as_is' | 'another_iteration' | 'reject';

async function claimDecision(
  projectId: number,
  decision: BuildReviewDecision,
  reason: string,
  instruction?: string,
): Promise<ActionResult & { businessId?: string; campaignId?: string }> {
  const response = await factoryFetch(`/internal/build-reviews/${projectId}/decisions`, {
    method: 'POST',
    body: { decision, reason, instruction },
  });
  const result = response.body?.result as Record<string, unknown> | undefined;
  if (!response.ok) return { ok: false, message: response.message };
  if (
    result?.kind !== 'claimed'
    || typeof result.businessId !== 'string'
    || typeof result.campaignId !== 'string'
  ) {
    return { ok: false, message: 'Фабрика повернула некоректне підтвердження рішення.' };
  }
  return {
    ok: true,
    message: response.message,
    businessId: result.businessId,
    campaignId: result.campaignId,
  };
}

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
  const decision = await claimDecision(
    projectId,
    'deploy_as_is',
    'Роман прийняв збірку попри вердикт критика',
  );
  if (!decision.ok || !decision.businessId || !decision.campaignId) return decision;

  revalidatePath('/inbox');
  revalidatePath(`/businesses/${decision.businessId}`);
  return { ok: true, message: decision.message };
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

  const decision = await claimDecision(
    input.projectId,
    'another_iteration',
    `Роман замовив ще одну ітерацію: ${note.slice(0, 200)}`,
    note,
  );
  if (!decision.ok || !decision.businessId || !decision.campaignId) return decision;

  revalidatePath('/inbox');
  revalidatePath(`/businesses/${decision.businessId}`);
  return { ok: true, message: decision.message };
}

/** Drop this lead: the demo is not worth more work. */
export async function rejectBuild(input: {
  projectId: number;
  reason: string;
}): Promise<ActionResult> {
  const found = await loadReviewable(input.projectId);
  if ('error' in found) return { ok: false, message: found.error };

  const reason = input.reason.trim() || 'Роман відхилив демо після рев’ю';
  const moved = await claimDecision(input.projectId, 'reject', reason);
  revalidatePath('/inbox');
  if (moved.businessId) revalidatePath(`/businesses/${moved.businessId}`);
  if (!moved.ok) return moved;
  return { ok: true, message: 'Бізнес відхилено. Evidence лишається в базі.' };
}
