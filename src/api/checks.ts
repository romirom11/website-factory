/**
 * Connectivity checks behind the UI's "Перевірити" buttons.
 *
 * Agent-provider checks run beside the runtime credential (the isolated runner
 * executor in production). Deterministic channel checks remain in the factory,
 * beside the network/configuration path they prove. The UI never performs a
 * synthetic substitute for either path.
 *
 * Every check RETURNS a result and never throws: a failing dependency must show
 * up as a red line in the console, not as a 500.
 *
 * `checkTelegram` sends a REAL message and `checkSmtp` opens a REAL connection.
 * Neither touches business data, and no business is ever contacted from here.
 */
import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { config } from '../config.js';
import { getSetting, masterKeyConfigured, settingSource } from '../lib/settings.js';
import * as waha from '../channels/waha.js';
import { claudeCodeRuntime } from '../agents/claudeCodeRuntime.js';
import { opencodeRuntime } from '../agents/opencodeRuntime.js';
import { getRuntime } from '../agents/runtime.js';
import { effectiveModel, effectiveModels } from '../agents/modelPolicy.js';
import { z } from 'zod';
import { readCodexAccountEmail } from './codexAccount.js';
import { usesRemoteAgentTransport } from '../agents/transport.js';

export type CheckKind =
  | 'claude' | 'codex' | 'opencode' | 'telegram' | 'telegram-send' | 'smtp' | 'imap' | 'waha';
export type AgentCheckKind = Extract<CheckKind, 'claude' | 'codex' | 'opencode'>;

export interface CheckResult {
  ok: boolean;
  /** One line Roman can act on. Ukrainian, because the console is. */
  message: string;
  /** Extra rows rendered under the message (key → value). */
  detail?: Record<string, string | number | boolean | null>;
  /** Set by the WAHA check when a QR scan is what is missing. */
  needsQr?: boolean;
}

const short = (err: unknown, max = 300): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, max);

// ─── Claude Code ─────────────────────────────────────────────────────────────

/**
 * Cheapest possible real agent call: a one-field structured answer. It proves
 * the token AND the subscription path, which a token-format check would not.
 */
async function checkClaude(modelOverride?: string): Promise<CheckResult> {
  const token = config.agents.oauthToken;
  const model = modelOverride ?? effectiveModel('claude-code', false, config.agents.modelInputs());
  try {
    // The claude-code runtime explicitly, not `getRuntime()`: this button says
    // "Claude", and it must not silently pass when AGENT_RUNTIME is `codex`.
    const res = await claudeCodeRuntime.structured(
      'settings-ping',
      'You answer with JSON only.',
      'Reply with {"pong": true}. Nothing else.',
      z.object({ pong: z.boolean() }),
      { retries: 0, timeoutMs: 90_000, model },
    );
    return {
      ok: res?.pong === true,
      message: res?.pong === true
        ? 'Claude Code відповідає — підписка робоча.'
        : 'Виклик пройшов, але відповідь несподівана.',
      detail: { token: token ? 'з налаштувань' : 'CLI-логін (токен не заданий)', model },
    };
  } catch (err) {
    return {
      ok: false,
      message: `Claude Code не відповів: ${short(err)}`,
      detail: { token: token ? 'заданий' : 'НЕ заданий', model },
    };
  }
}

// ─── Codex CLI ───────────────────────────────────────────────────────────────

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, out: short(err) });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, out: short(err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * `codex login status` is the CLI's own answer to "am I signed in?".
 *
 * This function only REPORTS. The login itself is a device flow started from
 * the settings page («Підключити» → `/internal/accounts/codex/start`, see
 * `accounts.ts`): the CLI prints a URL and a code, Roman signs in on
 * openai.com, and the CLI polls until the credential lands in the `codexhome`
 * volume. Nothing here brokers his ChatGPT session — the browser step is his.
 */
async function checkCodex(): Promise<CheckResult> {
  const bin = config.agents.codexBin;
  const { code, out } = await run(bin, ['login', 'status']);
  if (code === null) {
    return { ok: false, message: `Codex CLI недоступний (${bin}): ${out.slice(0, 200)}` };
  }
  const text = out.trim();
  const loggedIn = code === 0 && !/not logged in|logged out|no credentials/i.test(text);
  const accountEmail = loggedIn ? await readCodexAccountEmail() : null;
  return {
    ok: loggedIn,
    message: loggedIn
      ? accountEmail
        ? `Codex залогінений як ${accountEmail}.`
        : `Codex залогінений: ${text.slice(0, 160) || 'ok'}`
      // The remedy is the «Підключити» button on this very card (it runs
      // `codex login --device-auth` in the runtime executor), so the message
      // must not send Roman to a terminal for something the page now does.
      : 'Codex не залогінений — натисни «Підключити».',
    detail: { accountEmail, bin, exit: code, output: text.slice(0, 300) },
  };
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────

/**
 * Same philosophy as checkClaude: the cheapest real agent call proves both the
 * login and the whole path, which no credential-file inspection could.
 * The credential lives in OpenCode's own home (`auth.json`); if it is missing
 * or its provider refuses, the remedy is `opencode auth login` in the executor.
 */
async function checkOpenCode(modelOverride?: string): Promise<CheckResult> {
  const bin = config.agents.openCodeBin;
  const model = modelOverride ?? effectiveModel('opencode', false, config.agents.modelInputs());
  try {
    // This runtime explicitly, not `getRuntime()`: the button says "OpenCode".
    const res = await opencodeRuntime.structured(
      'settings-ping',
      'You answer with JSON only.',
      'Reply with {"pong": true}. Nothing else.',
      z.object({ pong: z.boolean() }),
      { retries: 0, timeoutMs: 90_000, model },
    );
    return {
      ok: res?.pong === true,
      message: res?.pong === true
        ? 'OpenCode відповідає — провайдер робочий.'
        : 'Виклик пройшов, але відповідь несподівана.',
      detail: { bin, model: model || 'типова модель CLI' },
    };
  } catch (err) {
    const text = short(err);
    const needsLogin = /auth|credential|login|provider/i.test(text);
    return {
      ok: false,
      message: needsLogin
        ? 'OpenCode не залогінений — виконай `docker compose exec agent-runner-executor opencode auth login` і залогінь потрібного провайдера.'
        : `OpenCode не відповів: ${text}`,
      detail: { bin, model: model || 'типова модель CLI' },
    };
  }
}

// ─── Telegram ────────────────────────────────────────────────────────────────

/** Sends a real test message: the only way to prove token + chat_id together. */
/**
 * SILENT verification: getMe proves the token, getChat proves the bot can see
 * the chat — neither sends anything. This is what the auto-check on /settings
 * page load runs; a background check that MESSAGES Roman every cache-cold
 * page open is how this started. Actually sending stays behind the explicit
 * «Надіслати тест» button (`checkTelegramSend`).
 */
async function checkTelegram(): Promise<CheckResult> {
  const token = config.telegram.botToken;
  const chatId = config.telegram.chatId;
  if (!token) return { ok: false, message: 'Bot token не заданий.' };
  if (!chatId) return { ok: false, message: 'Chat ID не заданий.' };
  try {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json()).catch(() => null) as any;
    if (!me?.ok) {
      return { ok: false, message: `Telegram відмовив боту: ${me?.description ?? 'невалідний токен'}`, detail: { errorCode: me?.error_code ?? null } };
    }
    const chat = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json()).catch(() => null) as any;
    if (!chat?.ok) {
      return { ok: false, message: `Бот @${me.result?.username} живий, але чат недоступний: ${chat?.description ?? 'chat not found'}`, detail: { errorCode: chat?.error_code ?? null } };
    }
    return { ok: true, message: `Бот @${me.result?.username} підключений до чату — без надсилань.`, detail: { bot: me.result?.username ?? null } };
  } catch (err) {
    return { ok: false, message: `Не достукались до Telegram: ${short(err)}` };
  }
}

/** The REAL send — only for the explicit «Надіслати тест» button. */
async function checkTelegramSend(): Promise<CheckResult> {
  const token = config.telegram.botToken;
  const chatId = config.telegram.chatId;
  if (!token) return { ok: false, message: 'Bot token не заданий.' };
  if (!chatId) return { ok: false, message: 'Chat ID не заданий.' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Перевірка з /settings — Telegram-канал фабрики працює.',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null) as any;
    if (data?.ok) {
      return { ok: true, message: 'Тестове повідомлення надіслано — перевір чат.', detail: { messageId: data.result?.message_id ?? null } };
    }
    return {
      ok: false,
      // Telegram's own words: "Unauthorized", "chat not found", …
      message: `Telegram відмовив: ${data?.description ?? `HTTP ${res.status}`}`,
      detail: { errorCode: data?.error_code ?? res.status },
    };
  } catch (err) {
    return { ok: false, message: `Не достукались до Telegram: ${short(err)}` };
  }
}

// ─── SMTP / IMAP ─────────────────────────────────────────────────────────────

async function checkSmtp(): Promise<CheckResult> {
  if (!config.smtp.host) return { ok: false, message: 'SMTP host не заданий.' };
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    tls: { rejectUnauthorized: config.smtp.rejectUnauthorized },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  try {
    await transport.verify();
    return {
      ok: true,
      message: 'SMTP приймає логін — відправляти можна.',
      detail: { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, from: config.smtp.from || '(не задано)' },
    };
  } catch (err) {
    return { ok: false, message: `SMTP відмовив: ${short(err)}`, detail: { host: config.smtp.host, port: config.smtp.port } };
  } finally {
    transport.close();
  }
}

async function checkImap(): Promise<CheckResult> {
  if (!config.imap.host) return { ok: false, message: 'IMAP host не заданий.' };
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    tls: { rejectUnauthorized: config.imap.rejectUnauthorized },
    logger: false,
  });
  try {
    await client.connect();
    const box = await client.mailboxOpen(config.imap.mailbox, { readOnly: true });
    const total = typeof box.exists === 'number' ? box.exists : 0;
    return {
      ok: true,
      message: `IMAP підключився: ${config.imap.mailbox}, листів ${total}.`,
      detail: { host: config.imap.host, port: config.imap.port, mailbox: config.imap.mailbox, messages: total },
    };
  } catch (err) {
    return { ok: false, message: `IMAP відмовив: ${short(err)}`, detail: { host: config.imap.host, port: config.imap.port } };
  } finally {
    await client.logout().catch(() => client.close?.());
  }
}

// ─── WAHA ────────────────────────────────────────────────────────────────────

/**
 * WAHA's own session states, in words (sweep 2026-08-20, P1-14).
 *
 * The check used to print `статус сесії: FAILED` — a raw upstream enum in the
 * middle of a Ukrainian sentence, which tells Roman nothing about what to DO.
 * The full set is documented on `WahaSession.status` in
 * `src/channels/waha.ts`; each one is phrased here as the state plus its
 * remedy, because every non-WORKING value has a different next action.
 *
 * The raw value is not thrown away — it stays in `detail.status`, which is
 * where the console shows the machine record.
 */
const WAHA_SESSION_STATES: Record<string, string> = {
  STOPPED: 'сесія зупинена — запусти її у WAHA',
  STARTING: 'сесія запускається — зачекай кілька секунд і перевір ще раз',
  SCAN_QR_CODE: 'телефон не підключений — скануй QR нижче',
  PASSKEY_REQUIRED: 'WhatsApp просить passkey — підтверди на телефоні',
  PASSKEY_CONFIRMATION_REQUIRED: 'підтверди вхід на телефоні',
  WORKING: 'працює',
  FAILED: 'сесія впала — перезапусти її у WAHA і скануй QR наново',
  MISSING: 'сесії не існує',
};

function wahaSessionState(status: string): string {
  return WAHA_SESSION_STATES[status] ?? `невідомий стан (${status})`;
}

/**
 * Two-step by design: `/ping` separates "WAHA is down / URL is wrong" from
 * "WAHA is up but the phone is not paired". Only the second is a QR situation,
 * and the UI renders the QR inline when `needsQr` comes back true.
 */
/** Names where the factory's WAHA key came from, for the 401 message. */
function describeWahaKeySource(): string {
  const src = settingSource('WAHA_API_KEY');
  const val = config.waha.apiKey;
  const tail = val ? `ключ …${val.slice(-4)}` : 'ПОРОЖНІЙ ключ';
  return `${tail} (джерело: ${src === 'db' ? 'переозначення в Налаштуваннях' : src === 'env' ? 'env деплою' : 'дефолт'})`;
}

async function checkWaha(): Promise<CheckResult> {
  const alive = await waha.ping();
  if (!alive) {
    return { ok: false, message: `WAHA не відповідає на ${config.waha.url}/ping.`, detail: { url: config.waha.url } };
  }
  try {
    const session = await waha.getSession();
    if (!session) {
      return {
        ok: false, needsQr: true,
        message: `Сесія "${config.waha.session}" не існує у WAHA. Створи/запусти її, потім скануй QR.`,
        detail: { url: config.waha.url, session: config.waha.session },
      };
    }
    const working = session.status === 'WORKING';
    return {
      ok: working,
      needsQr: session.status === 'SCAN_QR_CODE' || session.status === 'STARTING',
      message: working
        ? `WhatsApp підключений (${session.me?.pushName ?? session.me?.id ?? 'номер невідомий'}).`
        // The remedy is part of the state phrase, so this sentence stays one
        // clause: WAHA itself is fine, the pairing is what is not.
        : `WAHA живий, але WhatsApp не підключений: ${wahaSessionState(session.status)}.`,
      detail: {
        url: config.waha.url, session: session.name, status: session.status,
        me: session.me?.id ?? null,
      },
    };
  } catch (err) {
    // An auth error here is the api key, not the pairing — say so plainly.
    const isAuth = err instanceof waha.WahaError && err.isAuth;
    return {
      ok: false,
      message: isAuth ? 'WAHA відхилив API key — перевір WAHA_API_KEY.' : `WAHA помилка: ${short(err)}`,
      detail: { url: config.waha.url, session: config.waha.session },
    };
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const CHECKS: Record<CheckKind, () => Promise<CheckResult>> = {
  claude: checkClaude,
  codex: checkCodex,
  opencode: checkOpenCode,
  telegram: checkTelegram,
  'telegram-send': checkTelegramSend,
  smtp: checkSmtp,
  imap: checkImap,
  waha: checkWaha,
};

export function isAgentCheckKind(kind: CheckKind): kind is AgentCheckKind {
  return kind === 'claude' || kind === 'codex' || kind === 'opencode';
}

/** Direct provider check used only inside the runner executor/local development. */
export async function runLocalAgentCheck(kind: AgentCheckKind, model?: string): Promise<CheckResult> {
  try {
    if (kind === 'claude') return await checkClaude(model);
    if (kind === 'opencode') return await checkOpenCode(model);
    return await checkCodex();
  } catch (err) {
    return { ok: false, message: `Перевірка впала: ${short(err)}` };
  }
}

export function isCheckKind(v: string): v is CheckKind {
  return v in CHECKS;
}

export async function runCheck(kind: CheckKind): Promise<CheckResult> {
  try {
    if (isAgentCheckKind(kind) && usesRemoteAgentTransport()) {
      const { remoteAgentTransport } = await import('../agents/remoteTransport.js');
      return await remoteAgentTransport.check(kind);
    }
    return await CHECKS[kind]();
  } catch (err) {
    return { ok: false, message: `Перевірка впала: ${short(err)}` };
  }
}

/**
 * Effective configuration as this process sees it RIGHT NOW. The UI shows it so
 * "я змінив ліміт — чи бачить його фабрика?" is answerable without reading logs.
 * Secrets are reported as booleans only.
 *
 * Models come from the selected RUNTIME through the shared policy
 * (`effectiveModels`) — no per-CLI branching here, so a new harness shows up
 * correctly without touching this file.
 */
export function effectiveConfig(): Record<string, unknown> {
  const runtime = getRuntime();
  const models = effectiveModels(runtime.id, config.agents.modelInputs());
  const shownModel = (model: string): string => model || 'типова модель CLI цього рантайму';
  const agentKinds = [
    'enrichment', 'qa', 'content', 'design', 'outreach', 'builder', 'visual-critique',
  ] as const;

  return {
    pid: process.pid,
    mode: config.mode,
    outreachDailyLimit: config.outreachDailyLimit,
    followupDays: config.followupDays,
    agentRuntime: runtime.id,
    agentModel: shownModel(models.normal),
    agentModelHeavy: shownModel(models.heavy),
    agentRuntimeByStage: Object.fromEntries(
      agentKinds.map((kind) => [kind, config.agents.runtimeFor(kind)]),
    ),
    agentConcurrency: config.agents.concurrency,
    claudeTokenPresent: Boolean(config.agents.oauthToken),
    telegramConfigured: Boolean(config.telegram.botToken && config.telegram.chatId),
    smtpHost: config.smtp.host || null,
    imapHost: config.imap.host || null,
    wahaUrl: config.waha.url,
    wahaSession: config.waha.session,
    demoBaseUrl: config.deploy.demoBaseUrl,
    uiBaseUrl: config.ui.baseUrl,
    generateImages: config.media.generateImages,
    socialDiscovery: config.socialDiscovery.enabled,
    workspaceGc: config.build.workspaceGc,
    masterKeyConfigured: masterKeyConfigured(),
    tz: getSetting('TZ'),
  };
}
