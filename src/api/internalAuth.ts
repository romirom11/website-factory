import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

/** Shared fail-closed authentication for every factory-internal endpoint. */
export function createInternalAuth(
  secret: () => string = () => config.ui.internalApiKey,
): MiddlewareHandler {
  return async (context, next) => {
    const expected = secret();
    if (!expected) {
      return context.json({ ok: false, error: 'internal api disabled', message: 'internal api disabled (no secret configured)' }, 503);
    }
    const given = context.req.header('x-internal-key') ?? '';
    const actualBytes = Buffer.from(given);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      log.warn('internal api rejected', { path: context.req.path });
      return context.json({ ok: false, error: 'unauthorized', message: 'unauthorized' }, 401);
    }
    await next();
  };
}
