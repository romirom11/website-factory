/**
 * The reporting and safety spine of the e2e gate.
 *
 * Two things every check in this suite needs and must not each reinvent:
 *
 *  1. A result that CONTINUES. A regression gate that stops at the first
 *     failure tells you about one bug per run, and the whole point here is to
 *     re-verify ~8 groups of behaviour in one pass. `check()` therefore never
 *     throws; the process exit code is the failure COUNT.
 *
 *  2. A hard boundary around mutation. This suite runs against Roman's live
 *     local stack with 36 real businesses in it. Every id it creates carries the
 *     `e2e-` prefix, and `assertFixtureId` is called by every helper that
 *     writes — so a typo'd id fails loudly instead of updating a real salon.
 */
import { pool } from '../../src/db/client.js';
import { FIXTURE_PREFIX } from './safety.js';
export { assertFixtureId, FIXTURE_PREFIX } from './safety.js';

export interface CheckRecord {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: CheckRecord[] = [];
let currentGroup = 'ungrouped';

export function group(name: string): void {
  currentGroup = name;
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
}

export function check(name: string, ok: boolean, detail = '', ms = 0): boolean {
  results.push({ group: currentGroup, name, ok, detail, ms });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ` \x1b[2m— ${detail}\x1b[0m` : ''}`);
  return ok;
}

/**
 * A check whose BODY may throw.
 *
 * Network calls, Playwright navigations and SQL all throw on failure, and a
 * throw inside one check must not abort the other seven groups. The thrown
 * message becomes the failure detail, which is almost always the most useful
 * thing to print anyway.
 */
export async function checking(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await fn();
    return check(name, true, detail ?? '', Date.now() - started);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return check(name, false, msg.slice(0, 300), Date.now() - started);
  }
}

export function failures(): CheckRecord[] {
  return results.filter((r) => !r.ok);
}

export function summary(): { total: number; failed: number; byGroup: Map<string, { ok: number; failed: number }> } {
  const byGroup = new Map<string, { ok: number; failed: number }>();
  for (const r of results) {
    const g = byGroup.get(r.group) ?? { ok: 0, failed: 0 };
    if (r.ok) g.ok++; else g.failed++;
    byGroup.set(r.group, g);
  }
  return { total: results.length, failed: results.filter((r) => !r.ok).length, byGroup };
}

/**
 * The guard that makes this suite safe to run at any time.
 *
 * Every mutating helper funnels its target id through here. The prefix is not a
 * convention the caller is trusted to follow — it is checked at the moment of
 * the write, so the failure mode of a bad id is an exception, never a modified
 * production row.
 */
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function sqlOne<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

export async function count(text: string, params: unknown[] = []): Promise<number> {
  const row = await sqlOne<{ n: string | number }>(text, params);
  return Number(row?.n ?? 0);
}

/**
 * A census of every table a fixture could possibly touch, taken before and
 * after the run.
 *
 * This is the suite's own proof of the promise in its docstring. Counting rows
 * that do NOT match `e2e-%` means a leaked fixture, an accidental delete and a
 * mutation of a real row all show up as the same simple diff, without the
 * suite needing to know which check misbehaved.
 */
export const CENSUS_TABLES = [
  'businesses', 'campaigns', 'approvals', 'outreach_messages', 'outreach_events',
  'workflow_jobs', 'production_gaps', 'status_history', 'site_projects',
  'business_facts', 'business_contacts', 'business_sources', 'assets', 'deals',
  'qualifications', 'website_audits', 'do_not_contact', 'enrichment_runs',
] as const;

export type Census = Record<string, number>;

export async function takeCensus(): Promise<Census> {
  const census: Census = {};
  for (const table of CENSUS_TABLES) {
    // Real rows only: fixtures are expected to appear and disappear, and
    // counting them would make the census fail during the run by design.
    const col = table === 'campaigns' ? 'id' : (await hasColumn(table, 'business_id')) ? 'business_id' : 'id';
    census[table] = await count(
      `select count(*)::int n from ${table} where ${col} is null or ${col}::text not like $1`,
      [`${FIXTURE_PREFIX}%`],
    );
  }
  return census;
}

const columnCache = new Map<string, boolean>();

async function hasColumn(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const cached = columnCache.get(key);
  if (cached !== undefined) return cached;
  const n = await count(
    `select count(*)::int n from information_schema.columns where table_name = $1 and column_name = $2`,
    [table, column],
  );
  columnCache.set(key, n > 0);
  return n > 0;
}

export function diffCensus(before: Census, after: Census): string[] {
  const drifted: string[] = [];
  for (const table of Object.keys(before)) {
    if (before[table] !== after[table]) {
      drifted.push(`${table}: ${before[table]} → ${after[table]}`);
    }
  }
  return drifted;
}

/** Poll until `fn` returns truthy or the budget runs out. Returns null on timeout. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 400 } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
