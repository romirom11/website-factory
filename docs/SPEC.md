# Websites Factory – специфікація v2

**Статус:** авторитетна затверджена специфікація реалізованої системи.
**Дата:** 2026-08-16; операційно звірено 2026-08-28.
**Замінює:** FACTORYFLOW.md (цільова спека v1) в частині архітектурних рішень; правила evidence, gates і меж автоматизації з v1 успадковуються повністю.
**Контекст:** у репозиторії вже є прототип (v0, коміти cfc9e57 і 6abb713). Він вважається чернеткою реалізації: після затвердження цієї спеки він приводиться у відповідність до неї, розбіжності вирішуються на користь спеки.

---

## 1. Що будуємо

Автономна фабрика, яка за один прохід кампанії робить:

```text
кампанія (місто + ніша)
→ discovery бізнесів
→ evidence package з provenance
→ qualification + scoring
→ персоналізований демосайт
→ автоматичний QA
→ приватний deploy
→ Telegram-сповіщення з лінком у Web UI
→ [approve у Web UI] → outreach каналом, який є у бізнеса
→ follow-ups → replies → won/lost
```

Одна-єдина ручна дія в циклі: рішення Approve/Reject у Web UI. Telegram лише
сповіщає та відкриває потрібну картку; команд і approval-кнопок у боті немає.

---

## 2. Архітектура: три шари

### 2.1 Детермінований шар (код, без LLM)

Оркестрація, стан і все, що не можна довіряти моделі:

| Компонент | Технологія | Відповідальність |
|---|---|---|
| State machine | TypeScript + PostgreSQL | статуси бізнесів, валідація переходів, append-only історія |
| Черга | pg-boss (живе в Postgres) | jobs, retries з backoff, idempotency, dead-letter, розклади |
| Роутер етапів | TypeScript | після кожного job вирішує наступний етап за статусом |
| Дедуп | TypeScript | place_id → телефон → домен → назва+гео |
| Scoring | TypeScript | детермінована формула, LLM може лише пояснювати |
| Outreach-гейти | TypeScript + Postgres | approval обов'язковий, окремий idempotency key на send, daily limit, do_not_contact |

Постулат: LLM ніколи не вирішує, "куди далі йде бізнес" і "чи можна відправляти". Це завжди код.

### 2.2 Сервісний шар (готові рішення, не пишемо самі)

| Сервіс | Рішення | Обґрунтування |
|---|---|---|
| **Google Maps discovery** | **gosom/google-maps-scraper** (Docker, REST API) | 4.2k зірок, активний (v1.14.0, 2026-05), MIT. Playwright всередині, але селектори підтримує ком'юніті. REST API для jobs, JSON-вихід, 33+ полів, вбудовані проксі (SOCKS5/HTTP), опційна email-екстракція через сайт бізнесу. Розглянуті альтернативи: omkarcloud (desktop-орієнтований, freemium 200 пошуків/міс) і Mahanaicoach kit (обгортка над gosom, 3 коміти) – відхилені. |
| Object storage | MinIO (S3-API) у compose; R2 як drop-in для проду | immutable raw evidence, assets, скриншоти |
| БД | PostgreSQL 16 | єдине джерело істини |
| Control UI | **Next.js веб-застосунок** (self-hosted, з auth) | основний інтерфейс керування: approval-черга, воронка, бізнеси, кампанії, jobs; працює і з телефона |
| Сповіщення | Telegram Bot API | ТІЛЬКИ сповіщення з лінками в UI: демо готове, reply, падіння, daily summary. Керування в Telegram немає |
| Email send/receive | Gmail Романа (SMTP app password + IMAP) | рішення Романа; ліміт Gmail ~500 листів/день, фабричний ліміт значно нижчий; за перших ознак спам-флагів переїзд на окремий домен |
| WhatsApp | WAHA (self-hosted WhatsApp HTTP API, Docker) | рішення Романа; сесія через QR-скан, persistent, webhooks на вхідні = reply detection; неофіційний протокол, тому окремий номер для розсилки і низькі обсяги (ризик бана номера) |
| Instagram | без автоматизації | DM-автоматизація = ризик бана акаунта; фабрика готує текст і шле картку в Telegram з one-tap переходом у профіль |
| Viber | без автоматизації | легального API для холодних вихідних немає; картка в Telegram з deep link `viber://chat?number=...` і готовим текстом; у Греції Viber масовий, тому детектиться в enrichment окремо |

### 2.3 Агентний шар: тільки через підписку, без API-білінгу

**Оплата:** весь агентний шар працює через subscription CLI, НЕ через
pay-per-token API. Account flow у `/settings/accounts` запускає login у
ізольованому runner executor; Claude/Codex credentials живуть тільки в окремих
runner volumes і невидимі factory/gateway. Agent SDK запускає той самий Claude
Code, тому робота тарифікується підпискою. `ANTHROPIC_API_KEY` ніде не
вимагається.

| Режим | Де застосовується | Механіка |
|---|---|---|
| **Code agent** (Agent SDK → Claude Code, workspace + інструменти) | site builder, QA-fix loop | ізольований workspace: Next.js-шаблон + immutable snapshot + brief + design + assets. Агент пише код, сам ганяє `pnpm build`, сам фіксить помилки. Результат тільки через `result.json`, який валідується схемою. Visual critique: агент читає скриншоти як файли (multimodal Read). Інтернету немає, крім пакетних реєстрів. |
| **Headless-виклик** (Claude Code `-p`, один хід, без інструментів) | enrichment-екстракція, content brief, 3 art directions, QA пакета, текст outreach | той самий runtime і та сама підписка; вихід парситься і валідується zod-схемою, невалідний = retry |

**Ліміти підписки як частина дизайну:** у Pro/Max є 5-годинні вікна і тижневі стелі. Тому: (а) конкурентність агентних jobs обмежена (1-2 одночасно, конфіг); (б) вичерпане вікно = job переходить у `retry_wait` до відновлення ліміту, НЕ у failed; черга продовжує сама; (в) у UI видно, що пайплайн стоїть через ліміт підписки, а не через помилку.

**Альтернативні runtimes:** Codex CLI (підписка ChatGPT) та OpenCode (підписка
будь-якого провайдера з каталогу models.dev: GLM Coding Plan, Kimi, Zen…)
реалізують той самий adapter interface. Runtime обирається глобально в UI для
всіх agent stages. OpenCode не має власної OS-пісочниці, тому в production
весь його процес запускається всередині Codex exact-root sandbox (той самий
bubblewrap-профіль, що для tool-процесів Codex; executor має
`systempaths=unconfined`, щоб у ньому монтувався приватний `/proc`, потрібний
Bun), а ключ провайдера ніколи не потрапляє в пісочницю: executor тримає loopback credential broker, який
підставляє ключ з `auth.json` і форвардить запит через egress-проксі. Ключі
підключаються в UI (форма provider + key у «Акаунтах»); які провайдери
пропускає egress, задає `OPENCODE_PROVIDERS` у compose (2026-09-02, замінює
попереднє правило «OpenCode лише для tool-free structured»).

### 2.4 Дизайн і моушн: проти ШІ-слоупу

Принцип: агент не вигадує дизайн з нуля, а **збирає з готових, зроблених людьми wow-компонентів** і слідує референсам.

- **Пул компонентів у шаблоні:** Aceternity UI (3D-картки, Spotlight, Background Beams; ~80 компонентів) + Magic UI (мікро-інтеракції; ~50) - обидві copy-paste/MIT, код лежить прямо в site-template, агент компонує з них.
- **Моушн-стек шаблону:** Tailwind + Framer Motion + GSAP з ScrollTrigger і SplitText (усі колишні платні GSAP-плагіни тепер безкоштовні комерційно) + Lenis smooth scroll; prefers-reduced-motion fallback обов'язковий.
- **Skills у builder-агента:** офіційні greensock/gsap-skills (core, timeline, scrolltrigger, react, performance) встановлені в `.claude/skills/` репозиторію.
- **Референси замість смаку моделі:** курована папка референсів на нішу (5-6 еталонних сайтів: скриншоти + нотатки, збирається один раз на нішу); design contract зобов'язаний посилатись на конкретні референси.
- **Критик з рубрикою:** visual-QA оцінює типографічну ієрархію, ритм відступів, обробку фото і доцільність моушну; ban-list слоупу (дефолтний Inter/Poppins, фіолетові градієнти, сітка з трьох однакових карток, emoji-буллети) - частина рубрики, знайдений слоуп = QA issue.

### 2.5 Медіа-генерація

**Зображення: gen-image skill (Codex CLI, gpt-image-2, підписка ChatGPT).** Скіл Романа лежить у `.claude/skills/gen-image/` фабрики; підтримує референс через `--ref`; жорсткий префікс проти "малювання" через Python/SVG вбудований у скіл. Використання: декоративна графіка, атмосферні фони, патерни, og-images. Обмеження evidence-first: AI-зображення позначаються `ai_generated` і НІКОЛИ не видаються за реальні фото бізнесу, інтер'єру чи робіт майстрів.

**Відео: Ken Burns (авто) + ручний wow-кліп (змінено 2026-08-22)**

FlowKit видалено. Причина: КОЖЕН міст до Google Flow (FlowKit, flow-agent,
gflow-cli) вимагає живого залогіненого Chrome поза датацентром — Google
bot-detection + reCAPTCHA роблять hosted-авторизацію нежиттєздатною (визнання
мейнтейнера gflow-cli у власному canary), а рішення Романа: «я не хочу на маку
нічого мати. Втрачається сенс автономної фабрики».

Відео тепер працює так:

1. **Автономний базовий шлях**: ffmpeg Ken Burns з реального hero-фото
   (детерміновано, офлайн, у контейнері) → якщо ffmpeg недоступний, CSS/GSAP
   Ken Burns у браузері без відеофайлу. Жодних зовнішніх залежностей.
2. **Wow-шлях (human-in-the-loop)**: відео-бриф ПИШЕ АРТ-ДИРЕКТОР у дизайн-
   контракті (`heroVideoBrief`, обов'язкове поле схеми v2) — під конкретний
   обраний напрямок: рух/світло/темп, стартовий кадр = реальне hero-фото,
   правило «нічого не вигадувати». Картка бізнесу (вкладка Демо) показує бриф
   ПІСЛЯ першої збірки; Роман генерує у будь-якому інструменті і завантажує
   mp4 тією ж карткою; файл реєструється як asset `hero_clip` (`ai_generated`,
   `private_demo_only`, generator=manual-upload), і наступна збірка/ітерація
   використовує його замість Ken Burns автоматично.
3. Автоматичний server-side бекенд може з'явитись пізніше ТІЛЬКИ як API без
   браузера по підписці/кредитах — окремим рішенням Романа.

Обмеження evidence-first незмінні: кліп оживлює РЕАЛЬНЕ фото (стартовий кадр —
evidence-фото), нічого не вигадує, позначається `ai_generated` і не видається
за реальне відео бізнесу.

---

## 3. Discovery через gosom: як саме

1. gosom піднімається як сервіс у `docker-compose` поруч із фабрикою (порт лише в локальній мережі compose).
2. Discovery-worker фабрики: тонкий клієнт. `POST /api/v1/jobs` зі списком queries кампанії (`"nail salon Patras"`, грецькі й англійські варіанти), depth і мовою, **email-екстракція ввімкнена одразу** (gosom краулить сайти бізнесів на контакти); далі polling статусу; потім забирає результат JSON.
3. Повний сирий JSON кожного job зберігається в object storage як immutable evidence; у БД пишеться source з url, capture time і object key.
4. Кожен запис мапиться в кандидата: name, category, address, lat/lng, phone, website, place_id/listing URL, rating, review_count (+ email, якщо ввімкнена екстракція) і йде в normalize/dedup.
5. Ліміти: depth і кількість queries обмежуються конфігом кампанії; між кампаніями пауза. Проксі зараз не вмикаються, але підтримка закладена: конфіг gosom приймає проксі-лист через env, поле лишається порожнім до потреби.
6. Здоров'я: якщо job повертає 0 результатів або gosom недоступний, це failure з алертом у Telegram, а не тихий нуль.

Google Places API не використовується: ні як основне джерело, ні як fallback (рішення Романа, 2026-08-16). Єдине джерело discovery – gosom.

---

## 4. Етапи пайплайна

Кожен етап: окремий job з input/output, retry-політикою і gate. Падіння одного бізнесу не зупиняє кампанію.

| # | Етап | Виконавець | Вихід / Gate |
|---|---|---|---|
| 0 | Campaign setup | CLI/dashboard | запис campaign; валідні geofence, queries, ліміти |
| 1 | Discovery | gosom через discovery-worker | candidates + raw JSON в storage |
| 2 | Normalize + dedup | код | стабільний business_id; дублікат приєднує source |
| 3 | Fast qualification | код | prequalified / needs_review / rejected з причиною |
| 4 | Deep enrichment | Playwright capture → structured call | facts з source_id і confidence; немає доказу = null + gap; окремо детектяться месенджери бізнесу: WhatsApp/Viber-маркери біля телефону, Instagram/Facebook профілі |
| 5 | Assets | код | файли з hash, source, dimensions, rights=`private_demo_only` |
| 6 | Website audit | Playwright | матриця http/https × www/non-www, desktop+mobile скриншоти, вердикт з 5 значень (`no_website`, `broken`, `outdated`, `working_with_https_issue`, `working_good`); соцпрофіль/каталог ≠ сайт — фіксується як контакт, не як окремий вердикт (рішення Романа 2026-08-19: `social_only` злито в `no_website`); суперечність з enrichment → needs_review |
| 7 | Scoring + незалежний QA | код + structured call (інший агент, ніж enrichment) | score з breakdown; QA-fail → needs_review |
| 8 | Production-readiness gate | код | qualified ≠ production_ready; gaps: identity, verified contact, 3+ послуги, 3+ assets, hero/logo, review context |
| 9 | Content brief + design | structured calls | brief тільки з verified фактів; 3 структурно різні art directions; рубрика обирає |
| 10 | Site build | **code agent** у workspace | Next.js static export; `pnpm build` зелений; факти тільки зі snapshot |
| 11 | Visual QA loop | Playwright + multimodal critique | 390/768/1440, overflow, console, битi assets, наявність контакту; issues → назад у workspace агента; ліміт 3 ітерації → needs_human_review |
| 12 | Private deploy | код | неугадуваний URL, noindex, health check; публічний домен клієнта не створюється |
| 13 | Approval | Web UI: approval-черга (+ Telegram-пуш з лінком) | без записаного в БД Approve send неможливий технічно |
| 14 | Outreach | канальні адаптери | пріоритет: живі канали перед поштою. WhatsApp (WAHA, авто) → Instagram (картка) → Viber (картка) → email (Gmail, авто, fallback); рівно один send на idempotency key |
| 15 | Follow-ups + replies | код + IMAP/webhook | стоп при reply/opt-out/bounce; reply → deal `replied` + пінг Роману |

---

## 5. Модель даних

Таблиці (реалізовані у v0, лишаються): `campaigns`, `businesses`, `business_sources`, `business_facts`, `business_contacts`, `assets`, `website_audits`, `qualifications`, `production_gaps`, `site_projects`, `approvals`, `outreach_messages`, `outreach_events`, `deals`, `do_not_contact`, `status_history`, `workflow_jobs`.

Інваріанти:

- факт без source_id не може стати verified;
- raw objects immutable, повторне захоплення = нова версія;
- каталог/booking-профіль не є owned website;
- дедуп ніколи не видаляє evidence;
- status_history append-only, кожен перехід має actor і reason.

## 6. Статуси

Business: `discovered → prequalified → enriching → needs_review → qualified → production_ready → site_in_progress → site_ready → outreach_approved → contacted → replied → meeting → proposal → won|lost`, термінальні: `rejected`, `duplicate`, `closed`, `do_not_contact`.

Job: `queued → running → succeeded | retry_wait | failed | needs_human | cancelled`. Статуси jobs і бізнесів не змішуються: падіння enrichment-job не робить бізнес rejected.

## 7. Помилки

- 429/5xx/timeout → retry з exponential backoff (ліміти на тип job);
- креденшели/auth → stop + Telegram alert;
- schema/provenance failure → needs_human, без retry-циклу;
- send-jobs НІКОЛИ не ретраяться автоматично;
- gosom повернув 0 → failure з алертом, не тихий пропуск;
- dead-letter видно в dashboard, з ручним retry.

## 8. Безпека і права

- **operational credentials — зашифровані в Postgres, редагуються в UI `/settings`** (AES-256-GCM під `SETTINGS_MASTER_KEY`); infra credentials (`DATABASE_URL`, `S3_*`, `UI_PASSWORD`/`UI_SESSION_SECRET`, `SETTINGS_MASTER_KEY`, порти) — в `.env`. Ніде в коді. *Рішення Романа 2026-08-17: зміна токена чи режиму dry_run/live не має вимагати редагування файлу і перестворення контейнерів; значення діють наживо (TTL 15с), порядок розв'язання БД → env → дефолт.*;
- фото за замовчуванням `private_demo_only`, зняття caution – тільки рішенням Романа;
- PII не збирається понад публічні business contacts;
- opt-out → do_not_contact назавжди, перевіряється в момент send;
- dashboard і demo-сервер не виставляються в публічний інтернет без auth/tunnel;
- всі approvals і sends мають audit trail.

## 9. Спостереження

Telegram: пуші про failed jobs, needs_human, готові до approve демо, replies,
daily summary, кожен з лінком у відповідне місце UI. UI: воронка, бізнеси,
approval-черга, logical jobs/attempts, runner health, blocked barriers і помилки.
Логи — redacted JSON з `campaignId`, `businessId`, `runId`/`jobId`. Операційні
метрики: discovered, dedup/suppression rate, qualified/production-ready rate,
build success, QA-ітерації, wall time per demo, reply rate і win rate.

---

## 10. План збірки (після затвердження спеки)

| Фаза | Зміст | Критерій приймання |
|---|---|---|
| A | gosom у compose + discovery-worker як API-клієнт; викинути рукописний Maps-скрейпінг | реальна кампанія Patras beauty дає 20+ кандидатів у БД з raw evidence |
| B | Прогін етапів 2-8 на цих кандидатах через Claude Code по підписці | 3+ бізнеси доходять до production_ready з чесними gaps в інших |
| C | Build + QA loop + deploy на одному бізнесі | демо відкривається по приватному URL, скриншоти і QA-звіт у storage |
| D | Web UI (approval-черга, воронка, кампанії, jobs) + Telegram-пуші + outreach у dry_run | пуш приходить з лінком, Approve в UI створює simulated send рівно один раз, ручні канали дають deep-link кнопку |
| E | live: SMTP-домен, follow-ups, IMAP replies | тестовий лист самому собі проходить весь цикл включно з reply |
| F | Імпорт legacy `/root/website-offers` | Get Nailed / MC Beauty / BE BEAUTIFUL у БД без дублювання, стара тека read-only |

Кожна фаза приймається Романом окремо, наступна не починається без цього.

---

## 11. Прийняті рішення Романа (2026-08-16)

1. **Email**: розсилка з Gmail Романа (SMTP app password + IMAP). Обмовка виконавця: якщо Gmail почне флагати листи або поставить під ризик особистий акаунт, переїзд на окремий домен, це рішення переглядається першим.
2. **WhatsApp**: через WAHA (self-hosted WhatsApp HTTP API), не Cloud API. Рекомендація: окремий номер під розсилку, бо протокол неофіційний і номер можна втратити.
3. **Проксі**: зараз не потрібні, підтримка закладена конфігом (порожній проксі-лист gosom).
4. **Хостинг**: у Романа є, деталі перед фазою E.
5. **Бюджет агентів на демосайт**: без ліміту.
6. **Hermes Agent**: не інтегрується.
7. **Email-екстракція gosom**: ввімкнена з першої кампанії.
8. **Пріоритет каналів outreach**: живі месенджери перед поштою. WhatsApp (авто через WAHA) → Instagram (ручна відправка з UI) → Viber (ручна відправка з UI) → email як fallback, коли месенджерів у бізнеса немає. Approval показує, який канал обраний і чому; канал можна змінити перед Approve.
9. **Керування через веб-UI (Next.js), не через Telegram.** Telegram лишається тільки каналом сповіщень з лінками в UI. Approval-черга, редагування повідомлень, зміна каналу, ручні дії з бізнесами і кампаніями - все у веб-застосунку.
10. **Агенти працюють по підписці, не по API.** Claude Code (Pro/Max), Codex
CLI (ChatGPT) або OpenCode з ключем провайдера по підписці (GLM Coding Plan,
Kimi тощо) живуть в ізольованому runner; OpenCode у production працює в тій
самій пісочниці, що Codex, через credential broker executor-а (§2.3). Жодного
pay-per-token білінгу; вичерпані ліміти підписки ставлять agent jobs на паузу,
а не валять їх; відхилений ключ (401/403) — це NEEDS_HUMAN «перепідключи», не
пауза.
11. **Дизайн-стек:** готові компоненти (Aceternity + Magic UI в шаблоні) + офіційні GSAP skills + куровані референси на нішу. Кастомні дизайн-skills не пишемо. (Розділ 2.4.)
12. **Відео: авто Ken Burns + ручний wow-кліп** (змінено 2026-08-22; було: FlowKit/Chrome-міст — видалено, бо кожен міст до Flow потребує живого Chrome поза датацентром, а на маку Роман нічого не тримає). Базово — ffmpeg Ken Burns з реального фото; wow — відео-бриф на картці бізнесу, Роман генерує і завантажує mp4, наступна збірка підхоплює. Без pay-per-use відео-API. (Розділ 2.5.)
13. **Зображення через gen-image skill Романа** (Codex CLI, gpt-image-2, підписка ChatGPT): декор/фони/патерни/og-images з позначкою `ai_generated`; ніколи не замінюють реальні фото бізнесу. (Розділ 2.5.)

---

## 12. Як фабрика виглядає з боку Романа

Це **набір Docker-сервісів на твоєму хостингу** (`docker compose up -d`: Postgres, MinIO, gosom, WAHA, factory-ядро, factory-UI), який працює 24/7. Керування - через власний веб-застосунок, Telegram - лише дзвіночок.

**1. Web UI (Next.js) - основний інтерфейс.** Самохостний застосунок з логіном, адаптивний (працює з телефона). Сторінки:

- **Approval-черга** - головна робоча сторінка. Кожен елемент: бізнес, score і чому він у черзі, вердикт по його поточному сайту, вбудований preview демосайту (desktop/mobile), обраний канал з поясненням, текст першого повідомлення в редагованому полі. Дії: Approve / Reject / змінити канал / відредагувати текст перед Approve. Для WhatsApp Approve = автоматична відправка; для Instagram/Viber після Approve з'являється кнопка з deep link і скопійованим текстом: тап, вставив, відправив, фабрика логує контакт і планує follow-up.
- **Воронка** - кампанії і бізнеси по статусах, drill-down у картку бізнесу: факти з джерелами, contacts, assets, скриншоти аудиту, gaps, історія статусів, всі повідомлення.
- **Кампанії** - створення і запуск кампанії формою (місто, ніша, queries, ліміти), стан поточних.
- **Jobs/помилки** - що впало, чому, кнопка retry; needs_human черга.
- **Розмови** - replies по бізнесах, стан deals (replied/meeting/proposal/won/lost), ручне оновлення стадії угоди.

**2. Telegram - тільки сповіщення**, кожне з лінком у відповідне місце UI: "демо готове → відкрити approval-чергу", "X відповів → відкрити розмову", "job впав → відкрити jobs", вечірній summary. Жодних кнопок керування в Telegram.

**3. Запуск кампанії** - форма в UI (CLI лишається для дебага).

Одноразовий сетап при розгортанні: provider login через `/settings/accounts`
(credential тільки в runner volume), Gmail app password, Telegram token,
пароль UI, QR-код WAHA окремим номером і Telegram-бот через BotFather. Після
цього фабрика самодостатня: рестарти переживає, стан у Postgres, черга сама
добирає незавершені jobs.
