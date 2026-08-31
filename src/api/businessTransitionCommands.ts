import type { Hono, MiddlewareHandler } from 'hono';
import {
  BusinessNotFoundError,
  IllegalBusinessTransitionError,
  TransitionReasonRequiredError,
} from '../orchestrator/statuses.js';
import {
  isBusinessStatus,
  type BusinessStatus,
  type BusinessTransitionResult,
} from '../orchestrator/businessStatus.js';

export interface OperatorTransitionCommand {
  businessId: string;
  expectedStatus: BusinessStatus;
  to: BusinessStatus;
  actor: 'roman';
  reason: string;
}

export type OperatorTransitionExecutor = (
  input: OperatorTransitionCommand,
) => Promise<BusinessTransitionResult>;

/** Mount the authenticated, factory-owned operator transition command. */
export function registerBusinessTransitionCommandRoute(
  app: Hono,
  internalAuth: MiddlewareHandler,
  execute: OperatorTransitionExecutor,
): void {
  app.post('/internal/business-transitions', internalAuth, async (context) => {
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return context.json({ ok: false, message: 'request body must be JSON' }, 400);

    const businessId = typeof body.businessId === 'string' ? body.businessId.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!businessId) return context.json({ ok: false, message: 'businessId is required' }, 400);
    if (!isBusinessStatus(body.expectedStatus)) {
      return context.json({ ok: false, message: 'unknown expectedStatus' }, 400);
    }
    if (!isBusinessStatus(body.to)) {
      return context.json({ ok: false, message: 'unknown target status' }, 400);
    }
    if (!reason) return context.json({ ok: false, message: 'reason is required' }, 400);

    try {
      const result = await execute({
        businessId,
        expectedStatus: body.expectedStatus,
        to: body.to,
        actor: 'roman',
        reason,
      });
      if (result.kind === 'conflict') {
        return context.json({
          ok: false,
          message: `business moved from ${result.expectedStatus} to ${result.currentStatus}`,
          result,
        }, 409);
      }
      return context.json({ ok: true, message: result.kind, result });
    } catch (error) {
      if (error instanceof BusinessNotFoundError) {
        return context.json({ ok: false, message: error.message }, 404);
      }
      if (
        error instanceof IllegalBusinessTransitionError
        || error instanceof TransitionReasonRequiredError
      ) {
        return context.json({ ok: false, message: error.message }, 400);
      }
      throw error;
    }
  });
}
