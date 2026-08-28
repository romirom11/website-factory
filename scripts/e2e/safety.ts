/** Shared mutation boundary for every product smoke/integration flow. */
export const FIXTURE_PREFIX = 'e2e-';

export function assertFixtureId(id: string, kind = 'entity'): string {
  if (!id.startsWith(FIXTURE_PREFIX)) {
    throw new Error(
      `refusing to mutate non-fixture ${kind} "${id}" (must start with "${FIXTURE_PREFIX}")`,
    );
  }
  return id;
}

export function assertFixtureIds(ids: readonly string[], kind = 'entity'): string[] {
  return ids.map((id) => assertFixtureId(id, kind));
}
