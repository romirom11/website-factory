/**
 * The retry loop shared by every adapter's `structured()`.
 *
 * Both adapters used to carry byte-identical loops whose only differences were
 * the log labels. Extracted so a third harness cannot grow a third copy that
 * silently diverges (the rate-limit pattern lists already had).
 *
 * Contract:
 *  - `RateLimitedError` is NOT an attempt: it propagates immediately, the job
 *    goes to `retry_wait`, and the retry budget is untouched (SPEC §2.3б);
 *  - an error already marked NEEDS_HUMAN (a rejected credential) propagates
 *    as-is: another attempt with the same key cannot succeed;
 *  - anything else is retried with linear backoff, then raised as
 *    `AgentSchemaError` (code NEEDS_HUMAN — SPEC §7: a schema failure never
 *    spins in a retry loop at the queue level).
 */
import { log } from '../lib/logger.js';
import { AgentSchemaError, isNeedsHumanError, isRateLimitedError, type AgentRuntimeId } from './types.js';

export async function withStructuredRetries<T>(args: {
  name: string;
  runtime: AgentRuntimeId;
  retries: number;
  /** One attempt, receiving its zero-based attempt number for logging. Slot
   * acquisition happens inside, so each try holds its own slot. */
  attempt: (attempt: number) => Promise<T>;
}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    try {
      return await args.attempt(attempt);
    } catch (err) {
      if (isRateLimitedError(err) || isNeedsHumanError(err)) throw err;
      lastErr = err;
      log.warn('agent attempt failed', {
        name: args.name, attempt, runtime: args.runtime,
        err: String((err as Error)?.message ?? err).slice(0, 300),
      });
      if (attempt < args.retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new AgentSchemaError(
    `agent "${args.name}" produced no schema-valid output after ${args.retries + 1} attempts: ` +
    String((lastErr as Error)?.message ?? lastErr).slice(0, 400),
  );
}
