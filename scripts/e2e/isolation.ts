const ISOLATION_MARKER = 'E2E_FACTORY_ISOLATED';

/**
 * Direct-handler acceptance tasks must not compete with the live core worker.
 * The Compose wrapper sets this marker only after stopping that service.
 */
export function assertFactoryTaskIsolated(task: string): void {
  if (process.env[ISOLATION_MARKER] === 'true') return;
  throw new Error(
    `${task} requires the isolated Compose wrapper; run its package script instead of invoking the file directly`,
  );
}
