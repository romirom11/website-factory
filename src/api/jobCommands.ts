import type { Hono, MiddlewareHandler } from 'hono';
import {
  isJobName,
  validateJobPayload,
  type JobName,
} from '../orchestrator/jobDefinitions.js';
import type {
  EnqueueResult,
  WorkflowJobPayload,
} from '../orchestrator/workflowRunStore.js';

export type JobCommandEnqueuer = (
  name: JobName,
  payload: WorkflowJobPayload,
  options?: { startAfterSeconds?: number; priority?: number },
) => Promise<EnqueueResult>;

function parseOptions(value: unknown): {
  ok: true;
  value: { startAfterSeconds?: number; priority?: number };
} | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: {} };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'options must be an object' };
  }
  const options = value as Record<string, unknown>;
  if (
    options.startAfterSeconds !== undefined
    && (!Number.isInteger(options.startAfterSeconds) || Number(options.startAfterSeconds) < 0)
  ) return { ok: false, message: 'startAfterSeconds must be a non-negative integer' };
  if (options.priority !== undefined && !Number.isInteger(options.priority)) {
    return { ok: false, message: 'priority must be an integer' };
  }
  return {
    ok: true,
    value: {
      ...(options.startAfterSeconds !== undefined
        ? { startAfterSeconds: Number(options.startAfterSeconds) }
        : {}),
      ...(options.priority !== undefined ? { priority: Number(options.priority) } : {}),
    },
  };
}

/** Mount the authenticated factory-owned job command endpoint. */
export function registerJobCommandRoute(
  app: Hono,
  internalAuth: MiddlewareHandler,
  enqueue: JobCommandEnqueuer,
): void {
  app.post('/internal/jobs', internalAuth, async (context) => {
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return context.json({ ok: false, message: 'request body must be JSON' }, 400);
    if (!isJobName(body.name)) {
      return context.json({ ok: false, message: `unknown job: ${String(body.name)}` }, 400);
    }
    const payload = body.payload;
    const validation = validateJobPayload(body.name, payload);
    if (!validation.ok) {
      return context.json({ ok: false, message: validation.issues.join('; ') }, 400);
    }
    const options = parseOptions(body.options);
    if (!options.ok) return context.json({ ok: false, message: options.message }, 400);

    const result = await enqueue(
      body.name,
      payload as WorkflowJobPayload,
      options.value,
    );
    const message = result.kind === 'accepted'
      ? 'job accepted'
      : `job already running as ${result.runId}`;
    return context.json(
      { ok: true, message, result },
      result.kind === 'accepted' ? 202 : 200,
    );
  });
}
