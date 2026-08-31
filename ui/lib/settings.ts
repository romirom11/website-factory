/**
 * UI side of the runtime settings store.
 *
 * The registry, encryption and resolution rules are the FACTORY's
 * (`src/lib/settings.ts`, imported here as `@factory/settings` — a symlink
 * locally, a copy in the Docker build). One definition, never a drifting
 * duplicate: a divergence would mean the UI writes rows the workers cannot
 * decrypt, or offers keys nothing reads.
 *
 * Everything here runs server-side only (it imports the DB client, which Next
 * refuses to bundle for the browser). Plaintext secrets never leave this
 * module: the page receives `hasValue` + a masked tail (last 4 characters).
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { fmtDate } from './format';
import {
  SETTINGS, SETTING_GROUPS, decryptSecret, encryptSecret, maskSecret,
  masterKeyConfigured, settingDef,
  type SettingDef, type SettingGroup,
} from '@factory/settings';
import {
  effectiveModels,
  type AgentRuntimeId, type ModelInputs, type SettingSource,
} from '@factory/models';

export { SETTINGS, SETTING_GROUPS, masterKeyConfigured };
export type { SettingDef, SettingGroup };

const PREFIX = 'setting:';
const HEARTBEAT_PREFIX = 'heartbeat:';

/** What a single setting looks like to the browser. Never carries a plaintext secret. */
export interface SettingView {
  key: string;
  label: string;
  group: SettingGroup;
  kind: SettingDef['kind'];
  secret: boolean;
  options?: string[];
  hint?: string;
  placeholder?: string;
  /** Rarely-touched field: the page keeps it behind «Показати всі параметри». */
  advanced: boolean;
  /** Non-secret effective value, or '' for secrets. */
  value: string;
  /** Secrets only: `••••1234`. Empty when nothing is stored. */
  masked: string;
  hasValue: boolean;
  /** Where the effective value comes from — surfaced so nothing is magic. */
  source: 'db' | 'env' | 'default';
  /**
   * What the value would become if the DB row were deleted — i.e. what «Скинути»
   * actually does. Only meaningful when `source === 'db'`; the button says it out
   * loud so resetting is never a leap of faith. Secrets report '' here: their
   * fallback exists or it does not, and the tail is not worth leaking twice.
   */
  fallback: { value: string; source: 'env' | 'default' } | null;
  /**
   * PRE-FORMATTED on the server, not an ISO string to be formatted in a client
   * render body.
   *
   * The group form this replaced was a client component and called
   * `new Date(updatedAt).toLocaleString('uk-UA')` inline — the exact pattern
   * `lib/format.ts` documents as forbidden. It produced the container's
   * timezone in the streamed HTML and the viewer's in the hydrated DOM, which
   * is a React hydration error (#418) for anyone whose phone is not on
   * Europe/Athens (sweep P2-6). Formatting once, here, removes the second
   * formatter entirely.
   */
  updatedAt: string | null;
  updatedBy: string | null;
}

interface Row { key: string; value: string; encrypted: boolean; updatedAt: Date | null; updatedBy: string | null }

async function settingRows(): Promise<Map<string, Row>> {
  const rows = await db.select({
    key: schema.settings.key,
    value: schema.settings.value,
    encrypted: schema.settings.encrypted,
    updatedAt: schema.settings.updatedAt,
    updatedBy: schema.settings.updatedBy,
  }).from(schema.settings).where(sql`${schema.settings.key} like ${`${PREFIX}%`}`);
  return new Map(rows.map((r) => [r.key.slice(PREFIX.length), {
    key: r.key.slice(PREFIX.length),
    value: r.value,
    encrypted: Boolean(r.encrypted),
    updatedAt: r.updatedAt ?? null,
    updatedBy: r.updatedBy ?? null,
  }]));
}

/**
 * Every registry entry with its EFFECTIVE value resolved exactly the way the
 * factory resolves it (DB → env → default), so what the page shows is what the
 * workers use.
 */
export async function loadSettingViews(): Promise<SettingView[]> {
  const rows = await settingRows();
  const runtimeRow = rows.get('AGENT_RUNTIME');
  const effectiveRuntime = (runtimeRow?.value
    || process.env.AGENT_RUNTIME
    || settingDef('AGENT_RUNTIME')?.default
    || 'claude-code') as AgentRuntimeId;

  // The two model fields are shared by every harness, and the policy that maps
  // them onto the selected runtime is ONE definition shared with the workers
  // (@factory/models). The UI renders exactly what the workers would pass:
  // registry defaults belong to the default runtime; any other runtime keeps
  // its own CLI default until Roman saves a value.
  const modelInputs: ModelInputs = {
    normal: rows.get('AGENT_MODEL')?.value || process.env.AGENT_MODEL || '',
    heavy: rows.get('AGENT_MODEL_HEAVY')?.value || process.env.AGENT_MODEL_HEAVY || '',
    normalSource: sourceOf(rows.get('AGENT_MODEL'), 'AGENT_MODEL'),
    heavySource: sourceOf(rows.get('AGENT_MODEL_HEAVY'), 'AGENT_MODEL_HEAVY'),
  };
  const effectiveModelFields = effectiveModels(effectiveRuntime, modelInputs);

  const defaultFor = (def: SettingDef): string => {
    if (def.key === 'AGENT_MODEL') return effectiveModelFields.normal;
    if (def.key === 'AGENT_MODEL_HEAVY') return effectiveModelFields.heavy;
    return def.default ?? '';
  };

  function sourceOf(row: Row | undefined, key: string): SettingSource {
    if (row !== undefined && row.value !== '') return 'db';
    if ((process.env[key] ?? '') !== '') return 'env';
    return 'default';
  }

  return SETTINGS.map((def) => {
    const row = rows.get(def.key);
    const envValue = process.env[def.key] ?? '';
    const fromDb = row !== undefined && row.value !== '';
    const source: SettingView['source'] = fromDb ? 'db' : (envValue !== '' ? 'env' : 'default');

    const plain = fromDb
      ? (def.secret ? decryptSecret(row!.value) : row!.value)
      : (envValue !== '' ? envValue : defaultFor(def));

    const fallback: SettingView['fallback'] = source !== 'db'
      ? null
      : envValue !== ''
        ? { value: def.secret ? '' : envValue, source: 'env' }
        : { value: def.secret ? '' : defaultFor(def), source: 'default' };

    return {
      key: def.key,
      label: def.label,
      group: def.group,
      kind: def.kind,
      secret: Boolean(def.secret),
      options: def.options,
      hint: def.hint,
      placeholder: def.placeholder,
      advanced: Boolean(def.advanced),
      // A secret's plaintext must not reach the client component at all.
      value: def.secret ? '' : plain,
      masked: def.secret ? maskSecret(plain) : '',
      hasValue: plain !== '',
      source,
      fallback,
      updatedAt: row?.updatedAt ? fmtDate(row.updatedAt) : null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

/** Effective plaintext for one key — server-only, used by checks that run in the UI. */
export async function effectiveValue(key: string): Promise<string> {
  const def = settingDef(key);
  if (!def) return '';
  const rows = await settingRows();
  const row = rows.get(key);
  if (row && row.value !== '') return def.secret ? decryptSecret(row.value) : row.value;
  return process.env[key] ?? def.default ?? '';
}

/**
 * Persist one setting. An empty value DELETES the row, which is what "очистити"
 * means: fall back to env/default rather than storing an empty override.
 * Secrets are encrypted before the write, so the table alone is not a
 * credential store (SPEC §8 as amended 2026-08-17).
 */
export async function saveSetting(key: string, value: string, updatedBy = 'roman'): Promise<void> {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  if (value === '') {
    await db.delete(schema.settings).where(eq(schema.settings.key, `${PREFIX}${key}`));
    return;
  }
  const stored = def.secret ? encryptSecret(value) : value;
  await db.insert(schema.settings)
    .values({ key: `${PREFIX}${key}`, value: stored, encrypted: Boolean(def.secret), updatedAt: new Date(), updatedBy })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: stored, encrypted: Boolean(def.secret), updatedAt: new Date(), updatedBy },
    });
}

// ─── System status ───────────────────────────────────────────────────────────

export interface HeartbeatView {
  group: string;
  at: string | null;
  /**
   * Decided ONCE here, not recomputed in the component, and the only `now`-derived
   * value that survives into the view.
   *
   * The raw age in seconds is deliberately NOT part of this type: every field of
   * a server component's result is serialised into the RSC payload, so a live
   * counter riding along unrendered is still a value that differs between the
   * streamed HTML and the payload — which is a hydration mismatch whether or not
   * anything displays it.
   */
  stale: boolean;
  /**
   * The beat's own CLOCK TIME, and the only form of it that may be rendered.
   *
   * Anything derived from `now` is unstable across one request: Next streams the
   * HTML shell and the RSC payload a moment apart, both are computed from a
   * fresh `Date.now()`, and any difference between them is a hydration mismatch
   * (React #418) — intermittently, whenever the two renders straddle a boundary.
   * Bucketing only moves the boundary; it does not remove it.
   *
   * The timestamp itself has no such problem: it is a value read from the
   * database, identical in both renders however long they are apart. "живий,
   * 00:52" also answers the real question ("is it beating?") better than a
   * counter that is stale the instant it is painted.
   */
  ageLabel: string | null;
  pid: number | null;
  capacity: Array<{
    group: string;
    active: number;
    waiting: number;
    limit: number;
    consumerHandles: number | null;
    consumerTarget: number | null;
  }>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function heartbeatCapacity(value: unknown): HeartbeatView['capacity'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const out: HeartbeatView['capacity'] = [];
  for (const [group, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const slots = item.slots;
    const consumers = item.consumers;
    if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) continue;
    const slot = slots as Record<string, unknown>;
    const active = finiteNumber(slot.active);
    const waiting = finiteNumber(slot.waiting);
    const limit = finiteNumber(slot.limit);
    if (active === null || waiting === null || limit === null) continue;
    const consumer = typeof consumers === 'object' && consumers !== null && !Array.isArray(consumers)
      ? consumers as Record<string, unknown>
      : null;
    out.push({
      group,
      active,
      waiting,
      limit,
      consumerHandles: finiteNumber(consumer?.handles),
      consumerTarget: finiteNumber(consumer?.target),
    });
  }
  return out.sort((a, b) => a.group.localeCompare(b.group));
}

/** Clock time of the beat. Depends only on the stored value, never on `now`. */
function beatLabel(at: Date): string {
  return at.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Worker liveness rows, stamped every 30s by each factory process. */
export async function loadHeartbeats(): Promise<HeartbeatView[]> {
  const rows = await db.select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings).where(sql`${schema.settings.key} like ${`${HEARTBEAT_PREFIX}%`}`);
  const now = Date.now();
  return rows.map((r) => {
    let parsed: { at?: string; pid?: number; capacity?: unknown } | null = null;
    try { parsed = JSON.parse(r.value); } catch { parsed = null; }
    const at = parsed?.at ? new Date(parsed.at) : null;
    return {
      group: r.key.slice(HEARTBEAT_PREFIX.length),
      at: at ? at.toISOString() : null,
      ageLabel: at ? beatLabel(at) : null,
      stale: at === null || now - at.getTime() > 120_000,
      pid: typeof parsed?.pid === 'number' ? parsed.pid : null,
      capacity: heartbeatCapacity(parsed?.capacity),
    };
  }).sort((a, b) => a.group.localeCompare(b.group));
}

export interface PendingJobs { queued: number; active: number; retryWait: number; failed: number }

/**
 * Queue depth, read from `workflow_jobs` — the SAME table the filter chips
 * directly below this widget count.
 *
 * It used to read `pgboss.job`, which produced the contradiction the audit
 * caught (2026-08-20, P0-3): the panel said «в черзі: 0 · в роботі: 0» while
 * the chips one line below said «У черзі 84 · Виконуються 4». Both were
 * honest about their own table and neither was the answer to the operator's
 * question. pg-boss archives and purges its rows on its own retention
 * schedule, so its table answers "what will pg-boss run next", not "what work
 * does the factory still owe" — and the second question is the one a health
 * panel exists for.
 *
 * Two statuses are deliberately in no bucket at all:
 *  - `stale`: the startup reconciler (`src/orchestrator/reconcile.ts`) marks a
 *    row `stale` precisely to say it is not owed work any more, and counting it
 *    as failed would replace one misleading number with another;
 *  - `retry_wait`: the chips below the widget give it its own «На паузі»
 *    bucket, and a subscription pause resumes on its own (SPEC §2.3б), so
 *    folding it into «в черзі» here would make the two rows disagree by one for
 *    a job that is neither queued nor stuck.
 *
 * Each bucket therefore maps 1:1 onto the chip beside it: «в черзі» = «У черзі»,
 * «в роботі» = «Виконуються», «failed» = «Помилки» + «Чекають рішення».
 */
export async function loadPendingJobs(): Promise<PendingJobs | null> {
  try {
    const res = await db.execute(sql`
      select
        count(*) filter (where coalesce(r.status, w.status) = 'queued')::int as queued,
        count(*) filter (where coalesce(r.status, w.status) = 'running')::int as active,
        count(*) filter (where coalesce(r.status, w.status) = 'retry_wait')::int as retry_wait,
        count(*) filter (where coalesce(r.status, w.status) in ('failed', 'needs_human'))::int as failed
      from workflow_jobs w
      left join workflow_job_runs r on r.id = w.run_id
      where w.run_id is null or w.attempt_sequence = r.current_attempt_sequence
    `);
    const r = (res.rows as Array<{
      queued: number;
      active: number;
      retry_wait: number;
      failed: number;
    }>)[0];
    return r ? {
      queued: Number(r.queued),
      active: Number(r.active),
      retryWait: Number(r.retry_wait),
      failed: Number(r.failed),
    } : null;
  } catch {
    return null;
  }
}
