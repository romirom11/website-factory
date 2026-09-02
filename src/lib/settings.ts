/**
 * Runtime settings store — operational configuration that lives in Postgres,
 * encrypted at rest, and is editable from the UI (`/settings`) WITHOUT a
 * restart or rebuild.
 *
 * Why this exists (Roman's decision, 2026-08-17): "Для чого мені
 * CLAUDE_CODE_OAUTH_TOKEN в env? Щоб потім перезавантажувати чи перебілдювати
 * все? Чому не зробити налаштування в UI і там усе робити?" — an operator
 * should be able to paste a token, scan a QR and flip dry_run/live from the
 * console, not by editing `.env` and recreating containers.
 *
 * Split of responsibilities:
 *   .env  → INFRA only: DATABASE_URL, S3_*, UI_PASSWORD / UI_SESSION_SECRET,
 *           SETTINGS_MASTER_KEY, ports. Things needed to boot and to decrypt.
 *   DB    → everything operational (tokens, SMTP/IMAP, WAHA, limits, mode).
 *
 * Resolution order at read time: process override → DB value → env var →
 * registry default.
 * Process overrides are explicit, scoped and in-memory only; acceptance tools
 * use them to target local adapters without mutating the operator's DB rows.
 * Env therefore remains a working fallback for a fresh box or a rollback, but
 * once a key is saved in the UI the DB wins.
 *
 * Caching: a whole-table snapshot with a 15s TTL. Every consumer reads through
 * `config.*` getters (see src/config.ts), so a change in the UI is visible to
 * the worker processes within 15 seconds with no restart. The TTL is the whole
 * invalidation strategy on purpose — LISTEN/NOTIFY would add a connection and a
 * failure mode for a 15s win.
 *
 * Encryption: AES-256-GCM under a single master key (`SETTINGS_MASTER_KEY`,
 * 32 bytes hex or base64). Stored as `enc:v1:<iv>:<tag>:<ciphertext>` (base64
 * segments). Without the master key secrets cannot be saved and existing ones
 * read back as empty — never as garbage, and never as a crash.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ─── Registry ────────────────────────────────────────────────────────────────

export type SettingGroup = 'agents' | 'outreach' | 'media' | 'system';

export type SettingKind = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea';

export interface SettingDef {
  /** Canonical key. Identical to the env var name, so env stays a valid fallback. */
  key: string;
  label: string;
  group: SettingGroup;
  kind: SettingKind;
  /** Secrets are encrypted at rest and never returned in full to the browser. */
  secret?: boolean;
  /** Value used when neither DB nor env has one. Always a string (the wire format). */
  default?: string;
  options?: string[];
  hint?: string;
  placeholder?: string;
  /** Return an error message, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
  /**
   * Rarely touched: timeouts, poll intervals, tolerances, scrape budgets.
   *
   * The UI hides these behind one «Показати всі параметри» toggle per group.
   * The test is "would Roman ever open this page in order to change it?" — a
   * daily send limit yes, a gosom job timeout no. Marking a field advanced does
   * NOT make it less real: it is the same registry entry, saved the same way,
   * and env/DB still override it identically.
   */
  advanced?: boolean;
}

const num = (min?: number, max?: number) => (v: string): string | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return 'має бути числом';
  if (min !== undefined && n < min) return `мінімум ${min}`;
  if (max !== undefined && n > max) return `максимум ${max}`;
  return null;
};

const url = (v: string): string | null => {
  if (v.trim() === '') return null;
  try { new URL(v); return null; } catch { return 'має бути URL (http://… або https://…)'; }
};

const csvNumbers = (v: string): string | null => {
  if (v.trim() === '') return null;
  return v.split(',').every((p) => Number.isFinite(Number(p.trim())) && p.trim() !== '')
    ? null : 'список чисел через кому, напр. 3,7';
};

/**
 * Card order on `/settings`, and the one-line answer to "що тут живе".
 *
 * The three credential groups that used to be here — telegram, email, whatsapp —
 * are gone as CARDS, not as keys: «Підключені акаунти» above now owns every
 * token, password and QR, so a second place to paste the same Gmail password was
 * two answers to one question. What is left of them (ports, mailbox names, TLS
 * flags, the WAHA session name) is plumbing around a connected account, so it
 * sits in the group whose job it serves.
 */
export const SETTING_GROUPS: Array<{ id: SettingGroup; title: string; blurb: string }> = [
  {
    id: 'agents', title: 'Агенти',
    blurb: 'Які моделі будують сайти і скільки викликів іде одночасно. Усе по підписці.',
  },
  {
    id: 'outreach', title: 'Outreach',
    blurb: 'Скільки листів на день, коли нагадувати, які адреси бачить бізнес.',
  },
  {
    id: 'media', title: 'Медіа',
    blurb: 'Звідки беруться відео, картинки і референси для дизайну.',
  },
  {
    id: 'system', title: 'Система',
    blurb: 'Пошук бізнесів, соцмережі, таймзона, прибирання після білдів.',
  },
];

export const SETTINGS: SettingDef[] = [
  // ── Агенти ────────────────────────────────────────────────────────────────
  {
    key: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Токен Claude Code', group: 'agents',
    kind: 'password', secret: true, advanced: true,
    hint: 'Звичайний шлях — кнопка «Підключити» в «Акаунтах» вище. Поле потрібне лише для локальної розробки або контрольованої одноразової міграції в runner.',
    placeholder: 'sk-ant-oat01-…',
  },
  {
    key: 'AGENT_RUNTIME', label: 'Чим виконувати агентні етапи', group: 'agents',
    kind: 'select', options: ['claude-code', 'codex', 'opencode'], default: 'claude-code',
    hint: 'Усі працюють по підписці. Оплата за токени недоступна в принципі. OpenCode ходить до провайдера, підключеного в «Акаунтах» (ключ GLM Coding Plan, Kimi тощо); у проді провайдер має бути в OPENCODE_PROVIDERS.',
  },
  {
    key: 'AGENT_MODEL', label: 'Модель для звичайних етапів', group: 'agents', kind: 'text',
    default: 'claude-sonnet-5',
    hint: 'Бріф, контент, перевірки — усе, крім дизайну і збірки сайту. Назва передається у вибраний вище CLI; для OpenCode — у форматі provider/model (напр. kimi-for-coding/k3, список: opencode models). Якщо нічого не зберегти для іншого рантайму, діє його власна типова модель.',
  },
  {
    key: 'AGENT_MODEL_HEAVY', label: 'Модель для дизайну і збірки', group: 'agents', kind: 'text',
    default: 'claude-opus-5',
    hint: 'Найдорожчі етапи, де якість помітна в результаті. Назва передається у вибраний вище CLI; якщо не задана, використовується звичайна модель або типова модель CLI.',
  },
  {
    key: 'AGENT_FIX_LIGHT', label: 'Фікс-ітерації легкою моделлю', group: 'agents',
    kind: 'boolean', default: 'true',
    hint: 'Точкові правки після критика йдуть звичайною моделлю замість важкої — швидше і дешевше. Повна збірка завжди на важкій.',
  },
  {
    key: 'AGENT_CONCURRENCY', label: 'Скільки агентів працює одночасно', group: 'agents',
    kind: 'number', default: '1', validate: num(1, 8),
    hint: 'Ліміт підписки спільний на всіх. Більше за 2 — і етапи починають відбирати вікно один в одного.',
  },
  {
    key: 'AGENT_CONCURRENCY_BUILD', label: 'Одночасних агентів на збірці сайтів', group: 'agents',
    kind: 'number', default: '', validate: num(1, 8), advanced: true,
    hint: 'Окремий ліміт для процесу factory-build. Порожньо = як у полі вище.',
  },
  {
    key: 'AGENT_CONCURRENCY_ENRICH', label: 'Одночасних агентів на зборі даних', group: 'agents',
    kind: 'number', default: '', validate: num(1, 8), advanced: true,
    hint: 'Окремий ліміт для процесу factory. Порожньо = як у полі вище.',
  },
  {
    key: 'BUILDER_MODE', label: 'Як запускати агента збірки', group: 'agents',
    kind: 'select', options: ['tmux', 'sdk'], default: 'tmux',
    hint: 'tmux — до збірки можна підключитись і бачити живий термінал агента. sdk — фонова сесія без термінала. Якщо на сервері немає tmux, збірка сама переходить на sdk.',
  },
  {
    key: 'BUILD_TERMINAL_WEB', label: 'Відкривати термінал збірки в браузері', group: 'agents',
    kind: 'boolean', default: 'true',
    hint: 'Піднімає ttyd на час збірки, щоб кнопка «Відкрити термінал» працювала. Вимкнено — сесія лишається в tmux, підключитись можна тільки по SSH.',
  },
  {
    key: 'BUILD_TERMINAL_BASE_URL', label: 'Адреса термінала збірки', group: 'agents',
    kind: 'text', validate: url, placeholder: 'https://<адреса цього UI>/terminal',
    hint: 'Куди веде кнопка «Відкрити термінал». Новий домен НЕ потрібен: у Dokploy додай до сервісу agent-runner-executor запис з тим САМИМ доменом, шлях /terminal, порт 7681 — і встав сюди https://<домен UI>/terminal. Порожньо = кнопки немає.',
  },
  {
    key: 'BUILD_TERMINAL_PORT', label: 'Порт термінала збірки', group: 'agents',
    kind: 'number', default: '7681', validate: num(1, 65535), advanced: true,
  },
  {
    key: 'BUILD_TERMINAL_WRITABLE', label: 'Дозволити писати в термінал збірки', group: 'agents',
    kind: 'boolean', default: 'false', advanced: true,
    hint: 'Втручання в живу збірку з клавіатури. За замовчуванням вимкнено: така правка змінює демо клієнта без approval і без сліду в історії.',
  },

  // ── Канали: усе, що лишилося поза «Підключеними акаунтами» ─────────────────
  // Токени й паролі тут теж є, бо ключ мусить існувати в реєстрі, щоб UI взагалі
  // вмів його писати — але всі вони advanced: нормальний шлях до них — картка
  // акаунта нагорі, а не це поле.
  {
    key: 'TELEGRAM_BOT_TOKEN', label: 'Токен Telegram-бота', group: 'outreach',
    kind: 'password', secret: true, advanced: true,
    hint: 'Звичайний шлях — картка Telegram в «Акаунтах» вище.',
    placeholder: '123456789:AA…',
  },
  {
    key: 'TELEGRAM_CHAT_ID', label: 'Кому слати сповіщення (chat id)', group: 'outreach',
    kind: 'text', advanced: true,
    hint: 'Заповнюється кнопкою «Знайти» в картці Telegram.',
  },

  { key: 'SMTP_HOST', label: 'Сервер вихідної пошти', group: 'outreach', kind: 'text', advanced: true, placeholder: 'smtp.gmail.com' },
  { key: 'SMTP_PORT', label: 'Порт вихідної пошти', group: 'outreach', kind: 'number', default: '587', validate: num(1, 65535), advanced: true },
  { key: 'SMTP_USER', label: 'Логін вихідної пошти', group: 'outreach', kind: 'text', advanced: true },
  { key: 'SMTP_PASS', label: 'Пароль вихідної пошти', group: 'outreach', kind: 'password', secret: true, advanced: true, hint: 'Для Gmail — app password, не основний пароль акаунта.' },
  {
    key: 'SMTP_FROM', label: 'Підпис відправника', group: 'outreach', kind: 'text',
    placeholder: 'Roman <roman@example.com>',
    hint: 'Саме це ім\'я і адресу бізнес побачить у листі.',
  },
  {
    key: 'SMTP_SECURE', label: 'Шифрування вихідної пошти', group: 'outreach', kind: 'select',
    options: ['', 'true', 'false'], advanced: true,
    hint: 'Порожньо = вибрати за портом (465 — одразу TLS, 587 — STARTTLS).',
  },
  { key: 'SMTP_MESSAGE_ID_DOMAIN', label: 'Домен у Message-ID', group: 'outreach', kind: 'text', default: 'factory.local', advanced: true, hint: 'Не міняй без потреби: по ньому фабрика впізнає відповіді на свої листи.' },
  { key: 'SMTP_UNSUBSCRIBE_TO', label: 'Адреса для відписки', group: 'outreach', kind: 'text', advanced: true, hint: 'Порожньо = та сама, що в підписі відправника.' },
  { key: 'SMTP_TLS_REJECT_UNAUTHORIZED', label: 'Перевіряти сертифікат вихідної пошти', group: 'outreach', kind: 'boolean', default: 'true', advanced: true },
  { key: 'IMAP_HOST', label: 'Сервер вхідної пошти', group: 'outreach', kind: 'text', advanced: true, placeholder: 'imap.gmail.com' },
  { key: 'IMAP_PORT', label: 'Порт вхідної пошти', group: 'outreach', kind: 'number', default: '993', validate: num(1, 65535), advanced: true },
  { key: 'IMAP_USER', label: 'Логін вхідної пошти', group: 'outreach', kind: 'text', advanced: true },
  { key: 'IMAP_PASS', label: 'Пароль вхідної пошти', group: 'outreach', kind: 'password', secret: true, advanced: true },
  { key: 'IMAP_MAILBOX', label: 'Папка, де шукати відповіді', group: 'outreach', kind: 'text', default: 'INBOX', advanced: true },
  { key: 'IMAP_SECURE', label: 'Шифрування вхідної пошти', group: 'outreach', kind: 'select', options: ['', 'true', 'false'], advanced: true, hint: 'Порожньо = вибрати за портом (993 — одразу TLS).' },
  { key: 'IMAP_TLS_REJECT_UNAUTHORIZED', label: 'Перевіряти сертифікат вхідної пошти', group: 'outreach', kind: 'boolean', default: 'true', advanced: true },
  { key: 'IMAP_MAX_PER_POLL', label: 'Скільки листів читати за раз', group: 'outreach', kind: 'number', default: '50', validate: num(1, 500), advanced: true },

  {
    key: 'WAHA_URL', label: 'Адреса WAHA', group: 'outreach', kind: 'text', default: 'http://waha:3000',
    validate: url, advanced: true,
    // The default is the COMPOSE address, because that is where the factory
    // actually runs. `127.0.0.1:3001` used to be the default and can never work
    // from inside a container: loopback there is the container itself, not the
    // host, so the ping failed on a stock deploy until someone typed this in by
    // hand. docker-compose.yml and scripts/migrate-env-to-settings.ts both
    // already said `waha:3000`; the registry was the one place that disagreed.
    hint: 'У Docker — http://waha:3000 (так і лишай). Тільки для запуску фабрики просто на маку, без контейнера, тут потрібно http://127.0.0.1:3001.',
  },
  { key: 'WAHA_API_KEY', label: 'Ключ доступу до WAHA', group: 'outreach', kind: 'password', secret: true, advanced: true, hint: 'Той самий рядок, що в змінній WAHA_API_KEY контейнера WAHA.' },
  { key: 'WAHA_SESSION', label: 'Назва сесії WhatsApp', group: 'outreach', kind: 'text', default: 'default', advanced: true },
  { key: 'WAHA_HOOK_HMAC_KEY', label: 'Ключ підпису вебхуків WAHA', group: 'outreach', kind: 'password', secret: true, advanced: true, hint: 'Має збігатися з WHATSAPP_HOOK_HMAC_KEY у контейнері WAHA, інакше вхідні відповіді відкидаються.' },
  {
    key: 'WAHA_CHECK_EXISTS', label: 'Перевіряти номер перед відправкою', group: 'outreach',
    kind: 'boolean', default: 'true',
    hint: 'Захищає від відправки на номер без WhatsApp — саме такі спроби найшвидше ведуть до блокування.',
  },

  // ── Медіа ─────────────────────────────────────────────────────────────────
  {
    key: 'MEDIA_GEN_IMAGES', label: 'Генерувати фонові зображення', group: 'media', kind: 'boolean', default: 'true',
    hint: 'Позначаються як ai_generated і ніколи не видаються за фото бізнесу. Вимкнено — білди швидші й повністю офлайнові.',
  },
  {
    key: 'LANDING_GALLERY', label: 'Показувати арт-директору чужі лендінги', group: 'media', kind: 'boolean', default: 'true',
    hint: 'Публічні скриншоти з landing.gallery як додаткові референси на етапі дизайну. Палітра все одно береться тільки з айдентики бізнесу, анімація — тільки з motion-паку.',
  },
  {
    key: 'LANDING_GALLERY_MAX_REFS', label: 'Скільки таких лендінгів брати', group: 'media', kind: 'number',
    default: '6', validate: num(1, 12), advanced: true,
    hint: 'Їхній API віддає по 4 за виклик, тож 6 — це два запити.',
  },
  {
    key: 'LANDING_GALLERY_TIMEOUT_MS', label: 'Таймаут landing.gallery (мс)', group: 'media', kind: 'number',
    default: '5000', validate: num(1000, 30000), advanced: true,
    hint: 'Навмисно короткий: джерело натхнення не має права гальмувати збірку.',
  },

  // ── Outreach ──────────────────────────────────────────────────────────────
  {
    key: 'FACTORY_MODE', label: 'Режим фабрики', group: 'outreach', kind: 'select',
    options: ['dry_run', 'live'], default: 'dry_run', advanced: true,
    hint: 'Перемикається кнопкою нагорі сторінки — це поле лишається як запасний шлях.',
  },
  {
    key: 'OUTREACH_DAILY_LIMIT', label: 'Максимум відправок на день', group: 'outreach',
    kind: 'number', default: '20', validate: num(0, 1000),
    hint: 'Денний ліміт на всі канали разом. 0 — зупинити відправки, не вимикаючи бойовий режим.',
  },
  {
    key: 'FOLLOWUP_SCHEDULE_DAYS', label: 'Нагадати через (днів)', group: 'outreach',
    kind: 'text', default: '3,7', validate: csvNumbers,
    hint: 'Через кому. «3,7» = перше нагадування на третій день після першого дотику, друге на сьомий.',
  },
  {
    key: 'DEMO_BASE_URL', label: 'Адреса, за якою відкриваються демо', group: 'outreach',
    kind: 'text', default: 'http://localhost:8788', validate: url,
    hint: 'Саме це посилання бізнес отримає в повідомленні — воно має бути доступним ззовні.',
  },

  // ── Система ───────────────────────────────────────────────────────────────
  {
    key: 'UI_BASE_URL', label: 'Адреса цієї консолі', group: 'system', kind: 'text',
    default: 'http://localhost:3000', validate: url,
    hint: 'Сюди ведуть усі посилання зі сповіщень у Telegram.',
  },
  {
    key: 'TZ', label: 'Таймзона', group: 'system', kind: 'text', default: 'Europe/Athens',
    hint: 'У цій зоні рахуються денні ліміти і дати нагадувань. Застосується після перезапуску контейнерів — Node читає TZ один раз на старті.',
  },
  {
    key: 'SOCIAL_DISCOVERY', label: 'Шукати профілі в соцмережах', group: 'system', kind: 'boolean', default: 'true',
    hint: 'Instagram і Facebook бізнесу — часто єдине джерело реальних фото і актуальних цін.',
  },
  {
    key: 'SOCIAL_FINDER', label: 'Хто шукає профілі', group: 'system', kind: 'select',
    options: ['both', 'engines', 'agent'], default: 'both',
    hint: 'Пошуковики — безкоштовно, але на сервері їх часто блокують. Агент — через інфраструктуру Anthropic, обходить блок і витрачає підписку. Обидва — спершу пошуковики, агент лише коли вони дали менше двох кандидатів.',
  },
  { key: 'SOCIAL_DISCOVERY_MAX_CANDIDATES', label: 'Скільки профілів перевіряти на бізнес', group: 'system', kind: 'number', default: '6', validate: num(1, 30), advanced: true },
  { key: 'SOCIAL_DISCOVERY_DELAY_MS', label: 'Пауза між пошуковими запитами (мс)', group: 'system', kind: 'number', default: '2500', validate: num(0, 60000), advanced: true, hint: 'Менша пауза швидше приводить до капчі.' },
  { key: 'SOCIAL_FINDER_MAX_CANDIDATES', label: 'Скільки кандидатів просити в агента', group: 'system', kind: 'number', default: '8', validate: num(1, 12), advanced: true },
  {
    key: 'GOSOM_RADIUS', label: 'Радіус пошуку бізнесів (м)', group: 'system', kind: 'number',
    default: '10000', validate: num(100, 200000),
    hint: 'Від центру міста з кампанії. 10000 — це приблизно все місто середнього розміру.',
  },
  { key: 'GOSOM_EMAIL_EXTRACTION', label: 'Витягувати email із сайтів бізнесів', group: 'system', kind: 'boolean', default: 'true', hint: 'Повільніше, але це головне джерело адрес для email-каналу.' },
  { key: 'GOSOM_DEPTH', label: 'Глибина прокрутки Google Maps', group: 'system', kind: 'number', default: '10', validate: num(1, 100), advanced: true, hint: 'Скільки разів догортати список результатів. Більше — більше бізнесів і довший скрейп.' },
  { key: 'GOSOM_ZOOM', label: 'Масштаб карти при пошуку', group: 'system', kind: 'number', default: '15', validate: num(1, 21), advanced: true },
  { key: 'GOSOM_MAX_TIME_SECONDS', label: 'Бюджет часу на один скрейп (с)', group: 'system', kind: 'number', default: '900', validate: num(240, 7200), advanced: true, hint: 'gosom відхиляє значення менші за 180.' },
  { key: 'GOSOM_JOB_TIMEOUT_SECONDS', label: 'Скільки чекати на результат скрейпу (с)', group: 'system', kind: 'number', default: '1800', validate: num(60, 14400), advanced: true },
  { key: 'GOSOM_PROXIES', label: 'Проксі для пошуку бізнесів', group: 'system', kind: 'textarea', secret: true, advanced: true, hint: 'По одному в рядку або через кому. Порожньо = ходити з IP сервера.' },
  {
    key: 'WORKSPACE_GC', label: 'Прибирати за собою після збірки', group: 'system', kind: 'boolean', default: 'true',
    hint: 'Видаляє node_modules і кеш білду (~735 МБ на сайт). Вихідний код демо лишається.',
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function isKnownSetting(key: string): boolean {
  return BY_KEY.has(key);
}

// ─── Encryption ──────────────────────────────────────────────────────────────

const ENC_PREFIX = 'enc:v1:';

/** Parse SETTINGS_MASTER_KEY (32 bytes as hex or base64). null = not configured. */
export function masterKey(): Buffer | null {
  const raw = (process.env.SETTINGS_MASTER_KEY ?? '').trim();
  if (!raw) return null;
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) buf = b;
    } catch { buf = null; }
  }
  return buf && buf.length === 32 ? buf : null;
}

export function masterKeyConfigured(): boolean {
  return masterKey() !== null;
}

export function encryptSecret(plain: string): string {
  const key = masterKey();
  if (!key) throw new Error('SETTINGS_MASTER_KEY is missing or not 32 bytes — cannot store secrets');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a stored value. Anything that is not our envelope is returned as-is
 * (a value written before encryption existed, or a non-secret row).
 * A failure returns '' rather than throwing: a wrong/rotated master key must
 * degrade to "not configured", never crash a worker mid-pipeline.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = masterKey();
  if (!key) return '';
  const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !ctB64) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

/** What the browser is allowed to see about a secret: existence + last 4 chars. */
export function maskSecret(plain: string): string {
  if (!plain) return '';
  if (plain.length <= 4) return '•'.repeat(plain.length);
  return `••••${plain.slice(-4)}`;
}

// ─── Cache + resolution ──────────────────────────────────────────────────────

export const SETTINGS_TTL_MS = 15_000;

/** Loader injected by the host process; keeps this module free of a DB import. */
export type SettingsLoader = () => Map<string, string>;

let snapshot = new Map<string, string>();
let loadedAt = 0;
let loader: SettingsLoader | null = null;
let processOverrides = new Map<string, string>();

/**
 * Temporarily override operational settings in this process only.
 *
 * This is the safe boundary for acceptance tools that must point live channel
 * code at local test adapters while the operator's DB settings remain loaded.
 * Restorers are LIFO so nested, narrowly-scoped overrides cannot silently
 * clobber each other.
 */
export function overrideSettingsForProcess(
  values: Readonly<Record<string, string>>,
): () => void {
  const previous = processOverrides;
  const next = new Map(previous);
  for (const [key, value] of Object.entries(values)) {
    if (!BY_KEY.has(key)) throw new Error(`unknown process setting override: ${key}`);
    next.set(key, value);
  }
  processOverrides = next;

  let active = true;
  return () => {
    if (!active) return;
    if (processOverrides !== next) {
      throw new Error('process setting overrides must be restored in LIFO order');
    }
    processOverrides = previous;
    active = false;
  };
}

/**
 * Install the synchronous snapshot source. The DB read itself is async, so the
 * host refreshes a cached map in the background (see `startSettingsRefresh`)
 * and this returns the latest known values without ever blocking a getter.
 */
export function installSettingsLoader(fn: SettingsLoader): void {
  loader = fn;
}

export function primeSettings(values: Map<string, string>): void {
  snapshot = values;
  loadedAt = Date.now();
}

export function settingsAgeMs(): number {
  return loadedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - loadedAt;
}

export function settingsStale(): boolean {
  return settingsAgeMs() > SETTINGS_TTL_MS;
}

function current(): Map<string, string> {
  if (loader && settingsStale()) {
    try { primeSettings(loader()); } catch { /* keep the last good snapshot */ }
  }
  return snapshot;
}

/**
 * Effective value for a key: process override → DB → env → registry default.
 * Secrets are decrypted here, so callers only ever see plaintext.
 */
export function getSetting(key: string): string {
  const overridden = processOverrides.get(key);
  if (overridden !== undefined) return overridden;
  const raw = current().get(key);
  if (raw !== undefined && raw !== '') {
    const def = BY_KEY.get(key);
    return def?.secret ? decryptSecret(raw) : raw;
  }
  const env = process.env[key];
  if (env !== undefined && env !== '') return env;
  return BY_KEY.get(key)?.default ?? '';
}

/** Where the effective value came from — shown in diagnostics so nothing is magic. */
export function settingSource(key: string): 'process' | 'db' | 'env' | 'default' {
  if (processOverrides.has(key)) return 'process';
  const raw = current().get(key);
  if (raw !== undefined && raw !== '') return 'db';
  const env = process.env[key];
  if (env !== undefined && env !== '') return 'env';
  return 'default';
}

export function getSettingNumber(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Booleans are "not false": an unset value keeps the registry default. */
export function getSettingBool(key: string, fallback: boolean): boolean {
  const v = getSetting(key).trim().toLowerCase();
  if (v === '') return fallback;
  return v !== 'false' && v !== '0' && v !== 'no';
}

export function getSettingEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = getSetting(key).trim() as T;
  return allowed.includes(v) ? v : fallback;
}
