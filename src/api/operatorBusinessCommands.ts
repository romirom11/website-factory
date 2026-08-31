import type { Hono, MiddlewareHandler } from 'hono';
import {
  DEAL_STATES,
  type DealState,
  type OperatorBusinessCommandService,
} from '../orchestrator/operatorBusinessCommandService.js';

export type OperatorBusinessCommandExecutor = Pick<
  OperatorBusinessCommandService,
  'markDoNotContact' | 'updateDealStage' | 'startBuild' | 'recollectFacts'
>;

function isDealState(value: unknown): value is DealState {
  return typeof value === 'string' && (DEAL_STATES as readonly string[]).includes(value);
}

function conflictStatus(kind: string): 404 | 409 {
  return kind === 'not_found' ? 404 : 409;
}

/** Mount consistent operator mutations behind the shared internal auth. */
export function registerOperatorBusinessCommandRoutes(
  app: Hono,
  internalAuth: MiddlewareHandler,
  execute: OperatorBusinessCommandExecutor,
): void {
  app.post('/internal/businesses/:businessId/do-not-contact', internalAuth, async (context) => {
    const businessId = context.req.param('businessId').trim();
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!businessId || !reason) {
      return context.json({ ok: false, message: 'businessId and reason are required' }, 400);
    }
    const result = await execute.markDoNotContact(businessId, reason);
    if (result.kind !== 'blocked') {
      return context.json({ ok: false, message: result.kind === 'not_found' ? 'business not found' : result.message, result }, conflictStatus(result.kind));
    }
    return context.json({ ok: true, message: 'business blocked permanently', result });
  });

  app.post('/internal/businesses/:businessId/deal-stage', internalAuth, async (context) => {
    const businessId = context.req.param('businessId').trim();
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!businessId || !isDealState(body?.state)) {
      return context.json({ ok: false, message: 'businessId and valid deal state are required' }, 400);
    }
    const result = await execute.updateDealStage(businessId, body.state);
    if (result.kind !== 'updated') {
      return context.json({ ok: false, message: result.kind === 'not_found' ? 'business not found' : result.message, result }, conflictStatus(result.kind));
    }
    return context.json({ ok: true, message: 'deal stage updated', result });
  });

  app.post('/internal/businesses/:businessId/builds', internalAuth, async (context) => {
    const businessId = context.req.param('businessId').trim();
    if (!businessId) return context.json({ ok: false, message: 'businessId is required' }, 400);
    const result = await execute.startBuild(businessId);
    if (result.kind !== 'started') {
      return context.json({ ok: false, message: result.kind === 'not_found' ? 'business not found' : result.message, result }, conflictStatus(result.kind));
    }
    return context.json({ ok: true, message: 'build queued', result }, result.job.kind === 'accepted' ? 202 : 200);
  });

  app.post('/internal/businesses/:businessId/recollect-facts', internalAuth, async (context) => {
    const businessId = context.req.param('businessId').trim();
    if (!businessId) return context.json({ ok: false, message: 'businessId is required' }, 400);
    const result = await execute.recollectFacts(businessId);
    if (result.kind === 'already_active') {
      return context.json({ ok: true, message: 'fact recollection already active', result });
    }
    if (result.kind !== 'started') {
      return context.json({ ok: false, message: result.kind === 'not_found' ? 'business not found' : result.message, result }, conflictStatus(result.kind));
    }
    return context.json({ ok: true, message: 'fact recollection queued', result }, result.job.kind === 'accepted' ? 202 : 200);
  });
}
