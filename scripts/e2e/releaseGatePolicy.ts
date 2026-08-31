export interface ReleaseGateDependency {
  name: string;
  cleanupAfter?: string;
}

/** Return only the adjacent cleanup owned by the gate that just failed. */
export function cleanupAfterFailure<T extends ReleaseGateDependency>(
  gates: readonly T[],
  failedIndex: number,
): T | null {
  const failed = gates[failedIndex];
  const candidate = gates[failedIndex + 1];
  return failed && candidate?.cleanupAfter === failed.name ? candidate : null;
}
