/**
 * Postgres side of the runtime settings store (see `src/lib/settings.ts` for
 * the registry, encryption and resolution rules).
 *
 * Kept separate from `settings.ts` on purpose: `settings.ts` is imported by
 * `config.ts`, which is imported by literally everything including the Next.js
 * UI's edge middleware path. Only this file talks to drizzle.
 *
 * The refresher keeps a synchronous snapshot warm so `config.*` getters never
 * become async: a background timer re-reads the whole `settings` table every
 * `SETTINGS_TTL_MS`. That is the entire invalidation strategy — a UI change is
 * live in the workers within 15 seconds, no restart, no NOTIFY plumbing.
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { log } from './logger.js';
import {
  SETTINGS_TTL_MS, encryptSecret, installSettingsLoader, primeSettings, settingDef,
} from './settings.js';

/** Only `setting:`-prefixed rows are configuration; the table also holds cursors. */
const PREFIX = 'setting:';

export function rowKey(key: string): string {
  return `${PREFIX}${key}`;
}

/** Read every configuration row as key → stored value (secrets still encrypted). */
export async function loadSettingsFromDb(): Promise<Map<string, string>> {
  const rows = await db.select({
    key: schema.settings.key,
    value: schema.settings.value,
  }).from(schema.settings).where(sql`${schema.settings.key} like ${`${PREFIX}%`}`);
  return new Map(rows.map((r) => [r.key.slice(PREFIX.length), r.value]));
}

export interface SettingRowMeta {
  key: string;
  encrypted: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function loadSettingsMeta(): Promise<Map<string, SettingRowMeta>> {
  const rows = await db.select({
    key: schema.settings.key,
    encrypted: schema.settings.encrypted,
    updatedAt: schema.settings.updatedAt,
    updatedBy: schema.settings.updatedBy,
  }).from(schema.settings).where(sql`${schema.settings.key} like ${`${PREFIX}%`}`);
  return new Map(rows.map((r) => [r.key.slice(PREFIX.length), {
    key: r.key.slice(PREFIX.length),
    encrypted: Boolean(r.encrypted),
    updatedAt: r.updatedAt ?? null,
    updatedBy: r.updatedBy ?? null,
  }]));
}

/**
 * Write one setting. Secrets are encrypted before they touch the row, so a
 * `pg_dump` or a stray `select * from settings` never yields a usable token.
 * An empty value DELETES the row, which is what "очистити" in the UI means:
 * fall back to env/default rather than storing an empty override.
 */
export async function writeSetting(
  key: string, value: string, updatedBy = 'roman',
): Promise<void> {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  if (value === '') {
    await db.delete(schema.settings).where(eq(schema.settings.key, rowKey(key)));
    return;
  }
  const stored = def.secret ? encryptSecret(value) : value;
  await db.insert(schema.settings)
    .values({
      key: rowKey(key), value: stored, encrypted: Boolean(def.secret),
      updatedAt: new Date(), updatedBy,
    })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: stored, encrypted: Boolean(def.secret), updatedAt: new Date(), updatedBy },
    });
}

// ─── Snapshot refresher ──────────────────────────────────────────────────────

let cache = new Map<string, string>();
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
const snapshotListeners = new Set<() => void>();

/** Subscribe to successful live snapshot refreshes without exposing secret values. */
export function subscribeSettingsChanges(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

/** Kick a background re-read; failures keep the previous snapshot. */
function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = loadSettingsFromDb()
    .then((values) => {
      cache = values;
      primeSettings(values);
      for (const listener of snapshotListeners) {
        try { listener(); } catch (err) {
          log.warn('settings listener failed', { err: String(err).slice(0, 200) });
        }
      }
    })
    .catch((err) => {
      log.warn('settings refresh failed, keeping last snapshot', { err: String(err).slice(0, 200) });
      // Re-prime the old snapshot so its timestamp advances and we do not
      // hammer a down database on every single getter.
      primeSettings(cache);
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Install the loader and load once. Every process that reads config should call
 * this at start-up: the workers, the API, and each Next.js server instance.
 * Idempotent.
 */
export async function initSettings(options?: { poll?: boolean }): Promise<void> {
  installSettingsLoader(() => {
    // Synchronous by contract: return what we have and trigger a refresh for
    // the next read. Never blocks a getter on I/O.
    void refresh();
    return cache;
  });
  await refresh();
  if (options?.poll !== false && !timer) {
    timer = setInterval(() => { void refresh(); }, SETTINGS_TTL_MS);
    timer.unref?.();
  }
}

export function stopSettingsRefresh(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Force a synchronous-looking reload (used right after a UI save). */
export async function reloadSettings(): Promise<void> {
  inFlight = null;
  await refresh();
}

// ─── Heartbeats ──────────────────────────────────────────────────────────────
// Worker processes stamp a row every 30s so the UI's "Стан системи" panel can
// tell "the factory is running" from "the factory is dead but the DB is fine".

const HEARTBEAT_PREFIX = 'heartbeat:';
export const HEARTBEAT_INTERVAL_MS = 30_000;

export async function writeHeartbeat(group: string, detail?: Record<string, unknown>): Promise<void> {
  const key = `${HEARTBEAT_PREFIX}${group}`;
  const value = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...detail });
  await db.insert(schema.settings)
    .values({ key, value, encrypted: false, updatedAt: new Date(), updatedBy: 'worker' })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date(), updatedBy: 'worker' } })
    .catch(() => { /* a heartbeat must never break a worker */ });
}

/** Remove a heartbeat that belonged to a retired worker topology. */
export async function retireHeartbeat(group: string): Promise<void> {
  if (!/^[a-z0-9,-]+$/i.test(group)) throw new Error(`invalid heartbeat group: ${group}`);
  await db.delete(schema.settings).where(eq(schema.settings.key, `${HEARTBEAT_PREFIX}${group}`));
}

/** Start stamping a heartbeat for this process's worker group. */
export function startHeartbeat(group: string, detail?: () => Record<string, unknown>): NodeJS.Timeout {
  void writeHeartbeat(group, detail?.());
  const t = setInterval(() => { void writeHeartbeat(group, detail?.()); }, HEARTBEAT_INTERVAL_MS);
  t.unref?.();
  return t;
}

export interface Heartbeat { group: string; at: Date | null; pid: number | null; raw: unknown }

export async function readHeartbeats(): Promise<Heartbeat[]> {
  const rows = await db.select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings).where(sql`${schema.settings.key} like ${`${HEARTBEAT_PREFIX}%`}`);
  return rows.map((r) => {
    let parsed: any = null;
    try { parsed = JSON.parse(r.value); } catch { parsed = null; }
    return {
      group: r.key.slice(HEARTBEAT_PREFIX.length),
      at: parsed?.at ? new Date(parsed.at) : null,
      pid: typeof parsed?.pid === 'number' ? parsed.pid : null,
      raw: parsed,
    };
  });
}
