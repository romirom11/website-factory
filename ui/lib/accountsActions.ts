'use server';

/**
 * Server actions for the "Підключені акаунти" block.
 *
 * Every one of these is a thin proxy to the factory's `/internal/accounts/*`
 * endpoints, for the same reason the checks are (see `settingsActions.ts`): the
 * factory API routes the flow to the runtime owner: the isolated runner
 * executor in production, or the factory process in explicit local-development
 * mode. Brokering a login from the UI container would authenticate the wrong
 * filesystem.
 *
 * No secret ever comes back through here. A finished Claude flow returns
 * "connected", never the token — that went straight into the runtime-owned
 * credential volume.
 */
import { revalidatePath } from 'next/cache';
import { effectiveValue, saveSetting } from './settings';

export type SessionPhase =
  | 'starting' | 'awaiting' | 'submitting' | 'done' | 'error' | 'cancelled';

export interface AccountSession {
  provider: string;
  phase: SessionPhase;
  url?: string;
  userCode?: string;
  message: string;
  startedAt: number;
  expiresInMs: number;
  cliTail?: string;
  check?: { ok: boolean; message: string; detail?: Record<string, unknown> };
}

function factoryApiBase(): string {
  return (process.env.FACTORY_API_URL ?? 'http://factory:8787').replace(/\/+$/, '');
}

function internalKey(): string {
  return process.env.INTERNAL_API_KEY ?? process.env.UI_SESSION_SECRET ?? process.env.UI_PASSWORD ?? '';
}

const NO_KEY: AccountSession = {
  provider: '', phase: 'error', startedAt: 0, expiresInMs: 0,
  message: 'INTERNAL_API_KEY / UI_SESSION_SECRET не заданий — фабрика не приймає внутрішні запити.',
};

async function callFactory<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<{ ok: boolean; data?: T; message?: string }> {
  const key = internalKey();
  if (!key) return { ok: false, message: NO_KEY.message };
  try {
    const res = await fetch(`${factoryApiBase()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-internal-key': key,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    const data = await res.json().catch(() => null) as T | null;
    if (!data) return { ok: false, message: `Фабрика відповіла ${res.status} без тіла.` };
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      message: `Не достукались до фабрики (${factoryApiBase()}): ${String(err).slice(0, 160)}. Контейнер factory піднятий?`,
    };
  }
}

/** Begin an interactive login. The URL arrives via `pollAccount` a moment later. */
export async function startAccount(provider: string): Promise<AccountSession> {
  const r = await callFactory<{ ok: boolean; session: AccountSession; message?: string }>(
    `/internal/accounts/${encodeURIComponent(provider)}/start`, { method: 'POST' },
  );
  if (!r.ok || !r.data?.session) {
    return { provider, phase: 'error', message: r.message ?? r.data?.message ?? 'Не вдалося стартувати.', startedAt: 0, expiresInMs: 0 };
  }
  return r.data.session;
}

/** Poll target while a flow is in flight. */
export async function pollAccount(provider: string): Promise<AccountSession | null> {
  const r = await callFactory<{ ok: boolean; session: AccountSession | null }>(
    `/internal/accounts/${encodeURIComponent(provider)}/status`, { timeoutMs: 15_000 },
  );
  if (!r.ok) {
    return { provider, phase: 'error', message: r.message ?? 'Фабрика недоступна.', startedAt: 0, expiresInMs: 0 };
  }
  return r.data?.session ?? null;
}

/** Claude only: hand the pasted code to the waiting CLI prompt. */
export async function submitAccountCode(provider: string, code: string): Promise<AccountSession> {
  const r = await callFactory<{ ok: boolean; session: AccountSession }>(
    `/internal/accounts/${encodeURIComponent(provider)}/submit-code`,
    { method: 'POST', body: { code } },
  );
  if (!r.ok || !r.data?.session) {
    return { provider, phase: 'error', message: r.message ?? 'Не вдалося передати код.', startedAt: 0, expiresInMs: 0 };
  }
  return r.data.session;
}

export async function cancelAccount(provider: string): Promise<AccountSession> {
  const r = await callFactory<{ ok: boolean; session: AccountSession }>(
    `/internal/accounts/${encodeURIComponent(provider)}/cancel`, { method: 'POST' },
  );
  if (!r.ok || !r.data?.session) {
    return { provider, phase: 'cancelled', message: r.message ?? 'Скасовано.', startedAt: 0, expiresInMs: 0 };
  }
  return r.data.session;
}

export async function disconnectAccount(
  provider: string,
  /** OpenCode only: which provider's key to remove. */
  providerId?: string,
): Promise<{ ok: boolean; message: string }> {
  const r = await callFactory<{ ok: boolean; message: string }>(
    `/internal/accounts/${encodeURIComponent(provider)}/disconnect`,
    { method: 'POST', body: providerId ? { providerId } : {} },
  );
  if (!r.ok) return { ok: false, message: r.message ?? 'Не вдалося.' };
  revalidatePath('/settings', 'layout');
  return { ok: Boolean(r.data?.ok), message: r.data?.message ?? '' };
}

// ─── OpenCode helper ─────────────────────────────────────────────────────────

export interface OpenCodeProviderStatus { id: string; name: string; connected: boolean }

/**
 * Providers the operator may connect (OPENCODE_PROVIDERS ∩ catalog in
 * production, the whole catalog in local development) and which of them
 * already hold a key. Comes from the runtime owner: it is the only place that
 * can see auth.json.
 */
export async function opencodeProviders(): Promise<{ providers: OpenCodeProviderStatus[]; message?: string }> {
  const r = await callFactory<{ ok: boolean; providers?: OpenCodeProviderStatus[]; message?: string }>(
    '/internal/accounts/opencode/status', { timeoutMs: 15_000 },
  );
  if (!r.ok) return { providers: [], message: r.message ?? 'Фабрика недоступна.' };
  return { providers: r.data?.providers ?? [], message: r.data?.message };
}

/** Store one provider key in OpenCode's auth.json (runner volume) and verify it with a real call. */
export async function connectOpenCode(providerId: string, key: string): Promise<AccountSession> {
  const id = providerId.trim();
  const k = key.trim();
  if (!id) return { provider: 'opencode', phase: 'error', message: 'Вибери провайдера.', startedAt: 0, expiresInMs: 0 };
  if (!k) return { provider: 'opencode', phase: 'error', message: 'Порожній ключ.', startedAt: 0, expiresInMs: 0 };
  const r = await callFactory<{ ok: boolean; session?: AccountSession; message?: string }>(
    '/internal/accounts/opencode/connect',
    { method: 'POST', body: { providerId: id, key: k }, timeoutMs: 150_000 },
  );
  if (!r.ok || !r.data?.session) {
    return { provider: 'opencode', phase: 'error', message: r.message ?? r.data?.message ?? 'Не вдалося підключити.', startedAt: 0, expiresInMs: 0 };
  }
  revalidatePath('/settings', 'layout');
  return r.data.session;
}

// ─── Telegram helper ─────────────────────────────────────────────────────────

export interface TelegramChat { id: string; title: string; type: string }

/**
 * Chats that have messaged the bot. `token` is passed when Roman typed one but
 * has not saved it yet; empty means "use the stored one".
 */
export async function findTelegramChats(
  token?: string,
): Promise<{ ok: boolean; message: string; chats: TelegramChat[] }> {
  const r = await callFactory<{ ok: boolean; message: string; chats: TelegramChat[] }>(
    '/internal/accounts/telegram/chats',
    { method: 'POST', body: { token: token ?? '' }, timeoutMs: 25_000 },
  );
  if (!r.ok) return { ok: false, message: r.message ?? 'Фабрика недоступна.', chats: [] };
  return { ok: Boolean(r.data?.ok), message: r.data?.message ?? '', chats: r.data?.chats ?? [] };
}

/** Save a chat id picked from that list, then prove it by sending a real message. */
export async function useTelegramChat(chatId: string): Promise<{ ok: boolean; message: string }> {
  const id = chatId.trim();
  if (!id) return { ok: false, message: 'Порожній chat id.' };
  try {
    await saveSetting('TELEGRAM_CHAT_ID', id, 'accounts-ui');
  } catch (err) {
    return { ok: false, message: `Не збереглося: ${String(err).slice(0, 160)}` };
  }
  revalidatePath('/settings', 'layout');
  return { ok: true, message: `Chat id ${id} збережено.` };
}

/** Save the bot token from the accounts block (secret → encrypted at rest). */
export async function saveTelegramToken(token: string): Promise<{ ok: boolean; message: string }> {
  const t = token.trim();
  if (!t) return { ok: false, message: 'Порожній токен.' };
  try {
    await saveSetting('TELEGRAM_BOT_TOKEN', t, 'accounts-ui');
  } catch (err) {
    return {
      ok: false,
      message: `Не збереглося: ${String(err).slice(0, 200)}. Найімовірніше не заданий SETTINGS_MASTER_KEY.`,
    };
  }
  revalidatePath('/settings', 'layout');
  return { ok: true, message: 'Токен збережено. Тепер знайди chat id.' };
}

// ─── Gmail helper ────────────────────────────────────────────────────────────

/**
 * Save the Gmail pair in one go: an app password is the same secret for SMTP
 * and IMAP, and the hosts/ports are fixed for Gmail. Typing one address and one
 * password should therefore fill six fields, not make Roman fill six fields.
 *
 * The 16-character app password is shown by Google in spaced groups of four;
 * pasting it verbatim is the single most common way this fails, so the spaces
 * are stripped here rather than blamed on him later.
 */
export async function saveGmail(
  address: string, appPassword: string,
): Promise<{ ok: boolean; message: string }> {
  const addr = address.trim();
  const pass = appPassword.replace(/\s+/g, '');
  if (!addr) return { ok: false, message: 'Адреса не задана.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { ok: false, message: 'Це не схоже на email-адресу.' };
  if (!pass) return { ok: false, message: 'App password не заданий.' };
  if (pass.length !== 16) {
    return { ok: false, message: `App password Google — рівно 16 символів (отримано ${pass.length}). Це не звичайний пароль акаунта.` };
  }

  try {
    // Gmail's endpoints are fixed; only the credentials are Roman's.
    await saveSetting('SMTP_HOST', 'smtp.gmail.com', 'accounts-ui');
    await saveSetting('SMTP_PORT', '587', 'accounts-ui');
    await saveSetting('SMTP_USER', addr, 'accounts-ui');
    await saveSetting('SMTP_PASS', pass, 'accounts-ui');
    await saveSetting('IMAP_HOST', 'imap.gmail.com', 'accounts-ui');
    await saveSetting('IMAP_PORT', '993', 'accounts-ui');
    await saveSetting('IMAP_USER', addr, 'accounts-ui');
    await saveSetting('IMAP_PASS', pass, 'accounts-ui');
    // Only set a From when there is none: Roman may want a display name.
    const from = await effectiveValue('SMTP_FROM');
    if (!from) await saveSetting('SMTP_FROM', addr, 'accounts-ui');
  } catch (err) {
    return {
      ok: false,
      message: `Не збереглося: ${String(err).slice(0, 200)}. Найімовірніше не заданий SETTINGS_MASTER_KEY.`,
    };
  }
  revalidatePath('/settings', 'layout');
  return { ok: true, message: 'Gmail збережено (SMTP + IMAP). Тисни «Перевірити».' };
}
