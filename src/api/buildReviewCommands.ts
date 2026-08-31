import type { Hono, MiddlewareHandler } from 'hono';
import {
  executeBuildReviewDecision,
  type BuildReviewDecision,
  type BuildReviewDecisionResult,
} from '../orchestrator/buildReviewDecision.js';

const DECISIONS = new Set<BuildReviewDecision>([
  'deploy_as_is', 'another_iteration', 'reject',
]);

export type BuildReviewExecutor = (input: {
  projectId: number;
  decision: BuildReviewDecision;
  reason: string;
  instruction?: string;
}) => Promise<BuildReviewDecisionResult>;

export function registerBuildReviewCommandRoute(
  app: Hono,
  internalAuth: MiddlewareHandler,
  execute: BuildReviewExecutor = executeBuildReviewDecision,
): void {
  app.post('/internal/build-reviews/:projectId/decisions', internalAuth, async (context) => {
    const projectId = Number(context.req.param('projectId'));
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return context.json({ ok: false, message: 'invalid project id' }, 400);
    }
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !DECISIONS.has(body.decision as BuildReviewDecision)) {
      return context.json({ ok: false, message: 'invalid build review decision' }, 400);
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return context.json({ ok: false, message: 'reason is required' }, 400);

    const result = await execute({
      projectId,
      decision: body.decision as BuildReviewDecision,
      reason,
      ...(typeof body.instruction === 'string'
        ? { instruction: body.instruction.trim() }
        : {}),
    });
    if (result.kind === 'conflict') {
      return context.json({ ok: false, message: result.message, result }, 409);
    }
    const message = result.enqueueResult?.kind === 'duplicate'
      ? 'Рішення записано; наступний крок уже стояв у черзі.'
      : result.enqueueResult?.kind === 'accepted'
        ? 'Рішення записано; наступний крок поставлено в чергу.'
        : 'Рішення записано.';
    return context.json({ ok: true, message, result });
  });
}
