import type { Hono, MiddlewareHandler } from 'hono';
import type { StopFailedBuildResult } from '../orchestrator/buildFailureDecision.js';

export type StopFailedBuildExecutor = (jobId: number) => Promise<StopFailedBuildResult>;

/** Mount the factory-owned composite decision for a failed build. */
export function registerBuildFailureCommandRoute(
  app: Hono,
  internalAuth: MiddlewareHandler,
  stop: StopFailedBuildExecutor,
): void {
  app.post('/internal/build-failures/:jobId/stop', internalAuth, async (context) => {
    const jobId = Number(context.req.param('jobId'));
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return context.json({ ok: false, message: 'invalid job id' }, 400);
    }
    const result = await stop(jobId);
    return context.json(result, result.ok ? 200 : 409);
  });
}
