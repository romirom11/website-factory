/**
 * Telegram = NOTIFICATIONS ONLY (decision #9). Every message carries a link
 * into the web UI, where the actual control lives. No buttons, no commands,
 * no approving from the chat.
 *
 * Token/chat absent => no-op with a warn, so the pipeline never depends on it.
 */
import { config } from '../config.js';
import type { AgentRuntimeId } from '../agents/types.js';
import { runtimeLabel } from '../agents/types.js';
import { log } from '../lib/logger.js';
import { jobDisplayTitle } from '../orchestrator/jobDefinitions.js';

/**
 * True when Telegram can attach a URL (inline buttons / clickable links).
 * Telegram rejects localhost/private URLs in inline keyboards, and a phone
 * could not open them anyway — in that case we degrade to plain text and the
 * settings page nags Roman to set a reachable UI_BASE_URL (Tailscale).
 */
function linkableBase(): boolean {
  try {
    const h = new URL(config.ui.baseUrl).hostname;
    return !(h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h));
  } catch { return false; }
}

/** One inline URL button. Ignored (with a hint appended) when the UI URL is not phone-reachable. */
function withButton(label: string, url: string): Record<string, unknown> | undefined {
  if (!linkableBase()) return undefined;
  return { reply_markup: { inline_keyboard: [[{ text: label, url }]] } };
}

/** Fire-and-forget Telegram notification. No-op if the bot is not configured. */
export async function notifyTelegram(text: string, extra?: Record<string, unknown>): Promise<number | null> {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    log.warn('telegram not configured, skipping notification', { text: text.slice(0, 400) });
    return null;
  }
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    }),
  });
  const data = await res.json().catch(() => null) as any;
  if (!data?.ok) {
    log.error('telegram send failed', { data });
    return null;
  }
  return data.result.message_id as number;
}

export async function sendTelegramPhoto(photoUrl: string, caption: string): Promise<void> {
  if (!config.telegram.botToken || !config.telegram.chatId) return;
  await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendPhoto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegram.chatId, photo: photoUrl, caption, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ─── UI link builders ────────────────────────────────────────────────────────
// One place that knows the UI's routes, so a route rename can't silently
// produce dead links in Telegram.

function base(): string {
  return config.ui.baseUrl.replace(/\/+$/, '');
}

/**
 * Deep links into the console (decision #9: Telegram notifies, the UI decides).
 *
 * Everything that needs Roman now lands on ONE page — `/inbox` — because that is
 * where the item actually is: an approval, a build the critic rejected, a broken
 * step and a reply are four cards in one list rather than four pages. `?business`
 * narrows the inbox to the one that was pushed, so a notification opens on its
 * own card and not on a list to search through.
 */
export const uiLinks = {
  approvalQueue: (businessId?: string): string =>
    businessId ? `${base()}/inbox?business=${encodeURIComponent(businessId)}` : `${base()}/inbox`,
  business: (businessId: string): string => `${base()}/businesses/${encodeURIComponent(businessId)}`,
  conversation: (businessId: string): string =>
    `${base()}/businesses/${encodeURIComponent(businessId)}#rozmova`,
  // A subscription pause is not a to-do item, so it points at the diagnostics
  // page rather than the inbox, which deliberately excludes `retry_wait`.
  jobs: (filter?: 'failed' | 'needs_human' | 'retry_wait'): string =>
    filter === 'retry_wait'
      ? `${base()}/settings/system?status=retry_wait`
      : `${base()}/inbox`,
  funnel: (): string => `${base()}/businesses`,
  campaigns: (): string => `${base()}/campaigns`,
};

/** Trailing hint when buttons are impossible (localhost UI). */
function noButtonHint(): string {
  return linkableBase() ? '' : '\n\n<i>Кнопки з лінками з\'являться, коли в Налаштуваннях → Система буде публічна адреса UI (Tailscale), а не localhost.</i>';
}

/** Ukrainian names for pipeline stages, sourced from the shared job contract. */
export function stageLabel(jobType: string): string { return jobDisplayTitle(jobType); }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Notification types (SPEC §9) ────────────────────────────────────────────

/** Demo is deployed and waiting for Approve/Reject. */
export async function notifyDemoReady(input: {
  businessId: string; name: string; score: number | null;
  channel: string | null; channelReason: string; demoUrl: string | null;
}): Promise<number | null> {
  return notifyTelegram(
    `🚀 <b>${esc(input.name)}</b>\nДемо готове — подивись і підтверди відправку.\n` +
    `Оцінка: ${input.score ?? '—'} · Канал: <b>${input.channel ?? 'немає'}</b> (${esc(input.channelReason)})` +
    noButtonHint(),
    withButton('Подивитись демо і вирішити', uiLinks.approvalQueue(input.businessId)),
  );
}

/** A business replied. */
export async function notifyReply(input: {
  businessId: string; name?: string; channel: string; preview: string;
}): Promise<number | null> {
  return notifyTelegram(
    `💬 <b>${esc(input.name ?? input.businessId)} відповів</b> (${esc(input.channel)}):\n` +
    `«${esc(input.preview.slice(0, 400))}»` + noButtonHint(),
    withButton('Відкрити розмову', uiLinks.conversation(input.businessId)),
  );
}

/**
 * A follow-up on a MANUAL channel (Instagram/Viber) is due.
 * The factory never sends there (SPEC §2.2), so the notification carries the
 * deep link and the prepared text: Roman taps, pastes, sends.
 */
export async function notifyManualFollowup(input: {
  businessId: string; name?: string; channel: string; index: number;
  deepLink: string | null; body: string;
}): Promise<number | null> {
  return notifyTelegram(
    `🔔 <b>Follow-up #${input.index}</b> — ${esc(input.name ?? input.businessId)} (${esc(input.channel)})\n` +
    `Канал ручний: відправ сам.\n` +
    (input.deepLink ? `Профіль: ${esc(input.deepLink)}\n` : '') +
    `\nТекст (натисни, щоб скопіювати):\n<code>${esc(input.body)}</code>` + noButtonHint(),
    withButton('Відкрити розмову', uiLinks.conversation(input.businessId)),
  );
}

/** A job failed for good or needs a human decision. */
export async function notifyJobProblem(input: {
  jobType: string; businessId?: string | null; campaignId?: string | null;
  needsHuman: boolean; error: string;
}): Promise<number | null> {
  return notifyTelegram(
    `⚠️ <b>${esc(stageLabel(input.jobType))}</b> ${input.needsHuman ? 'чекає твого рішення' : 'не вдався'}\n` +
    (input.businessId ? `Бізнес: ${esc(input.businessId)}\n` : '') +
    `Причина: ${esc(input.error.slice(0, 300))}` + noButtonHint(),
    withButton('Відкрити Вхідні', uiLinks.jobs(input.needsHuman ? 'needs_human' : 'failed')),
  );
}

/** Subscription window exhausted — a pause, not an error (SPEC §2.3б). */
export function subscriptionPauseText(input: {
  jobType: string;
  resumesAt: Date;
  runtime?: AgentRuntimeId;
}): string {
  return `⏸ Пауза: вичерпано ліміт підписки ${runtimeLabel(input.runtime)}.\n` +
    `Крок «${esc(stageLabel(input.jobType))}» продовжиться сам о ` +
    `${input.resumesAt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Athens' })}. Це не помилка.`;
}

export async function notifySubscriptionPause(input: {
  jobType: string;
  businessId?: string | null;
  resumesAt: Date;
  runtime: AgentRuntimeId;
}): Promise<number | null> {
  return notifyTelegram(
    subscriptionPauseText(input) +
    noButtonHint(),
    withButton('Подивитись у системі', uiLinks.jobs('retry_wait')),
  );
}

/**
 * A build the server restart killed.
 *
 * Sent by `workers/main.ts` from the reconciler's report, never by the
 * reconciler itself — see the no-notify rule in `orchestrator/reconcile.ts`.
 *
 * It lives here rather than being assembled at the call site because this
 * module owns the two rules every notification has to obey: HTML escaping of
 * a business name that came from Google Maps, and degrading to plain text when
 * UI_BASE_URL is localhost (Telegram rejects such URLs in inline keyboards, so
 * a hand-rolled `reply_markup` at the call site would silently fail to send).
 */
export async function notifyBuildInterrupted(input: {
  businessId: string; name: string;
}): Promise<number | null> {
  return notifyTelegram(
    `🧱 Збірку <b>${esc(input.name)}</b> перервано перезапуском сервера.\n`
    + 'Нічого не втрачено — відкрий картку і запусти збірку заново.'
    + noButtonHint(),
    withButton('Відкрити картку', uiLinks.business(input.businessId)),
  );
}

/** Evening digest. */
export async function notifyDailySummary(lines: string[]): Promise<number | null> {
  return notifyTelegram(
    `📊 <b>Підсумок дня</b>\n${lines.map((l) => esc(l)).join('\n')}` + noButtonHint(),
    withButton('Відкрити бізнеси', uiLinks.funnel()),
  );
}
