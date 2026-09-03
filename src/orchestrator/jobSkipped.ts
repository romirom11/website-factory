/**
 * A job that found nothing left to do.
 *
 * Workers race against operator decisions and against their own successors:
 * by the time a build-site delivery arrives the project may be cancelled, by
 * the time a 40-minute agent run finishes the business may have been stopped.
 * Those handlers used to `return` and the queue wrote `succeeded` — a green
 * row for work that never happened, which is exactly how «Продовжити збірку»
 * on BEAUTIFY Laser (2026-09-03) looked like it ran and did not.
 *
 * Throwing this instead makes the queue record the attempt as `skipped` with
 * the reason, never retried, never notified as a failure, never counted as
 * success. The operator vocabulary for it is «Пропущено: стан змінився».
 */
export class JobSkippedError extends Error {
  readonly code = 'SKIPPED';

  constructor(reason: string) {
    super(reason);
    this.name = 'JobSkippedError';
  }
}

export function isJobSkippedError(error: unknown): error is JobSkippedError {
  return error instanceof JobSkippedError
    || (error as { code?: string } | null)?.code === 'SKIPPED';
}
