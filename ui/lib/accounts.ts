/**
 * "Підключені акаунти" — what is configured, as seen at page render time.
 *
 * This is deliberately the CHEAP half of the answer: whether the credentials
 * exist and are well-formed. Whether they actually WORK comes from
 * `lib/checks.ts`, which reads the factory's cached real checks (a Claude ping,
 * an SMTP handshake, a live WAHA session query) — that is what the card's
 * status chip shows.
 *
 * So this file no longer decides any status word. It answers exactly one
 * question the checks cannot: "is there anything saved here at all?", which is
 * the difference between «не підключено» (nothing to check) and «помилка»
 * (something is saved and the dependency refused it). Roman's complaint on
 * 2026-08-21 was precisely that this file's cheap guess was being displayed as
 * if it were the verdict.
 */
import { effectiveValue } from './settings';

/** Row state before any live check has run. */
export type AccountReadiness = 'configured' | 'missing' | 'partial';

export interface AccountStatus {
  id: 'claude' | 'codex' | 'opencode' | 'telegram' | 'whatsapp' | 'gmail';
  readiness: AccountReadiness;
  /** One line describing what IS set, or what is missing. */
  detail: string;
}

export interface AccountsSnapshot {
  claude: AccountStatus;
  codex: AccountStatus;
  opencode: AccountStatus;
  telegram: AccountStatus;
  whatsapp: AccountStatus;
  gmail: AccountStatus;
  /**
   * The Telegram chat id in plain sight.
   *
   * Not a secret (it is a number identifying Roman's own chat with his own bot)
   * and the card shows it as its own labelled row, so "which chat does this
   * send to" is answerable without opening «Розширені».
   */
  telegramChatId: string | null;
  /** Secrets cannot be stored at all without it — the block says so up top. */
  masterKey: boolean;
}

const mask = (v: string): string => (v.length <= 4 ? '••••' : `••••${v.slice(-4)}`);

export async function loadAccounts(): Promise<AccountsSnapshot> {
  const [
    claudeToken, tgToken, tgChat,
    smtpUser, smtpPass, imapUser, imapPass,
    wahaUrl, wahaKey, wahaSession,
  ] = await Promise.all([
    effectiveValue('CLAUDE_CODE_OAUTH_TOKEN'),
    effectiveValue('TELEGRAM_BOT_TOKEN'),
    effectiveValue('TELEGRAM_CHAT_ID'),
    effectiveValue('SMTP_USER'),
    effectiveValue('SMTP_PASS'),
    effectiveValue('IMAP_USER'),
    effectiveValue('IMAP_PASS'),
    effectiveValue('WAHA_URL'),
    effectiveValue('WAHA_API_KEY'),
    effectiveValue('WAHA_SESSION'),
  ]);

  // Claude may live in the legacy settings store or the runner credential
  // volume, which is intentionally invisible from the database. The real
  // runner check, not this cheap snapshot, settles whether it is connected.
  const claude: AccountStatus = claudeToken
    ? {
      id: 'claude', readiness: 'configured',
      detail: claudeToken.startsWith('sk-ant-oat')
        ? `токен ${mask(claudeToken)}`
        : `токен ${mask(claudeToken)} — формат незвичний (очікується sk-ant-oat…)`,
    }
    : { id: 'claude', readiness: 'partial', detail: 'стан credential volume — за перевіркою' };

  // Codex has no stored setting at all: its credential is a file in the
  // codexhome volume. Only `codex login status` in the runner knows, so this
  // row is always "перевір" until the button says otherwise.
  const codex: AccountStatus = {
    id: 'codex', readiness: 'partial',
    detail: 'логін у volume codexhome — статус лише за перевіркою',
  };

  // Same shape as Codex: OpenCode keeps its provider keys in its own home
  // (`auth.json` in the runner volume), invisible from the database. The card
  // lists connected providers live from the runtime owner.
  const opencode: AccountStatus = {
    id: 'opencode', readiness: 'partial',
    detail: 'ключі провайдерів в auth.json OpenCode — статус лише за перевіркою',
  };

  const telegram: AccountStatus = tgToken && tgChat
    ? { id: 'telegram', readiness: 'configured', detail: `бот ${mask(tgToken)}, chat ${tgChat}` }
    : tgToken || tgChat
      ? { id: 'telegram', readiness: 'partial', detail: tgToken ? 'є токен, нема chat id' : 'є chat id, нема токена' }
      : { id: 'telegram', readiness: 'missing', detail: 'не налаштовано' };

  const gmailComplete = Boolean(smtpUser && smtpPass && imapUser && imapPass);
  const gmailAny = Boolean(smtpUser || smtpPass || imapUser || imapPass);
  const gmail: AccountStatus = gmailComplete
    ? { id: 'gmail', readiness: 'configured', detail: `${smtpUser} (SMTP + IMAP)` }
    : gmailAny
      ? {
        id: 'gmail', readiness: 'partial',
        detail: `неповно: ${[
          smtpUser ? null : 'SMTP user', smtpPass ? null : 'SMTP pass',
          imapUser ? null : 'IMAP user', imapPass ? null : 'IMAP pass',
        ].filter(Boolean).join(', ')} — нема`,
      }
      : { id: 'gmail', readiness: 'missing', detail: 'не налаштовано' };

  // WAHA needs a URL and a key to even be asked about pairing; the pairing
  // itself (SCAN_QR_CODE vs WORKING) only the check can tell.
  const whatsapp: AccountStatus = wahaUrl && wahaKey
    ? { id: 'whatsapp', readiness: 'partial', detail: `${wahaUrl}, сесія ${wahaSession || 'default'} — стан за перевіркою` }
    : { id: 'whatsapp', readiness: 'missing', detail: wahaUrl ? 'нема WAHA API key' : 'нема WAHA URL' };

  const { masterKeyConfigured } = await import('./settings');

  return {
    claude, codex, opencode, telegram, whatsapp, gmail,
    telegramChatId: tgChat || null,
    masterKey: masterKeyConfigured(),
  };
}
