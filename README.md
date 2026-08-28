# Websites Factory

Автономна фабрика: пошук локальних бізнесів → evidence package → персоналізований демосайт → approval-gated outreach → replies/CRM.

Code-first мультиагентна система: **PostgreSQL = state machine і джерело істини, pg-boss = черга jobs, агенти = workers для нечітких етапів**. Оркеструє детермінований код, не LLM.

Агентний шар працює **тільки по підписці, без API-білінгу** (спека §2.3, рішення №10) — деталі в [docs/AGENT-RUNTIME.md](docs/AGENT-RUNTIME.md). Етапи 9-12 (brief → дизайн → збірка → QA → приватний деплой) описані в [docs/BUILD-PIPELINE.md](docs/BUILD-PIPELINE.md). Production builder має два повністю ізольовані взаємозамінні рантайми (`AGENT_RUNTIME`):

- **claude-code (default)**: Claude Code по підписці Pro/Max. Два режими виклику — headless structured (enrichment, brief, дизайн-напрямки, QA, текст outreach) і code agent з workspace (builder + QA-fix loop): ізольований Next.js-шаблон, immutable snapshot, brief, design contract і локальні assets; агент сам пише код, сам ганяє `pnpm install`/`pnpm build`, сам фіксить помилки. QA-issues повертаються в той самий workspace.
- **codex**: те саме через Codex CLI по підписці ChatGPT; один вибір у UI застосовується до всіх агентних етапів.

OpenCode також реалізує tool-free structured-виклики. Його tool-enabled builder у production fail-closed вимкнений, бо pinned CLI не має OS sandbox для subprocess tools; вибір OpenCode для збірки дає явний `needs_human`, а не слабший security mode.

`ANTHROPIC_API_KEY` не потрібен ніде.

## Архітектура

```text
CLI/schedule
   ↓
discover (gosom/google-maps-scraper REST)  [worker]
   ↓ raw -> object storage
normalize + dedup (детерміновано)          [worker]
   ↓
fast-qualify (детерміновано)               [worker]
   ↓
enrich (browser capture -> LLM structured) [agent worker]
   ├─ collect-assets (hash+provenance)     [worker]
   └─ audit-website (URL matrix + browser) [worker]
        ↓
score-and-qa (детермін. score + незалежний QA agent)
   ↓
readiness-gate (qualified ≠ production_ready; gaps)
   ↓
content-and-design (brief agent + 3 art directions + детермінована рубрика)
   ↓
build-site (builder agent у Next.js workspace; код перевіряє build + provenance)
   ↺ visual-qa (Playwright 390/768/1440 + reduced-motion + visual critique agent)
   ↓
deploy-demo (неугадуваний URL, noindex, health check)
   ↓
request-approval (Telegram-лінк → Approve / Reject / Changes у Web UI)
   ↓ ТІЛЬКИ після Approve
send-outreach (месенджери -> email; WAHA, НЕ Cloud API | manual card)
   ↓
follow-ups за розкладом · poll-replies (IMAP) · daily summary
```

Статуси бізнесу: `discovered → prequalified → enriching → needs_review → qualified → production_ready → site_in_progress → site_ready → outreach_approved → contacted → replied → meeting → proposal → won|lost` (+ `rejected`, `duplicate`, `closed`, `do_not_contact`). Всі переходи валідуються state machine і пишуться в append-only `status_history`.

## Швидкий старт

```bash
cp .env.example .env        # лише infra/secrets для boot; operational config заповнюється в UI
docker compose up -d postgres minio
pnpm install
pnpm db:migrate
pnpm all                    # workers + JSON API (:8787) + demo server (:8788)
pnpm ui:dev                 # контрольний UI (:3000) — саме він, а не 8787, є інтерфейсом
```

Або повністю в Docker: `docker compose up -d --build`.

Запуск кампанії:

```bash
pnpm factory campaign:create --id gr-patras-beauty \
  --country gr --city Patras --niche beauty --lang el \
  --queries "nail salon,beauty salon,κομμωτήριο" --target 30
pnpm factory campaign:run --id gr-patras-beauty
```

Далі все їде саме: контрольний UI на `http://localhost:3000` показує воронку, jobs, кампанії, розмови і чергу approve (`:8787` — це службовий JSON API і вебхуки, не інтерфейс). Коли сайт пройде QA і задеплоїться, у Telegram прийде **посилання** на картку в UI — approve робиться в UI (рішення №9). Після Approve повідомлення відправляється рівно один раз (окремий idempotency key на send).

Імпорт наявного `/root/website-offers`:

```bash
pnpm import:legacy --dry-run                 # план, нічого не пишеться
pnpm import:legacy --dir /root/website-offers
```

## Що потрібно від тебе, щоб фабрика працювала «бойово»

| Ключ | Для чого | Без нього |
|---|---|---|
| Логін підпискою через `/settings/accounts` → runner credential volume; локально — логін самого CLI | всі агенти (enrichment, brief, дизайн, builder, QA) | агентні етапи падають у needs_human |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | сповіщення з UI-лінками, алерти, daily summary | approvals лишаються в UI/БД |
| `SMTP_*` + `IMAP_*` | email outreach + reply detection | email-канал недоступний |
| `WAHA_API_KEY` + QR-логін окремого номера | автоматичний WhatsApp через self-hosted WAHA (рішення №2, НЕ Meta Cloud API) | картка з wa.me-лінком (ручний тап) |
| `FACTORY_MODE=live` | реальні відправки | `dry_run`: весь флоу працює, send симулюється |

Instagram DM не автоматизується принципово (бан акаунта): фабрика готує текст і показує deep link у UI; Telegram лише сповіщає.

## Правила, які вбудовані в код (не в документацію)

- Кожен факт має `source_id` → `business_sources` → immutable raw object. Факт без source не стає verified.
- Вигадані контакти/послуги/відгуки неможливі by construction: агенти бачать лише захоплений raw-контент, **і кожне їхнє твердження ще раз звіряється з процитованим джерелом** перед записом (`src/enrichment/grounding.ts`). Промпт «не вигадуй» — це прохання; перевірка — це гарантія. На реальному прогоні модель таки додала 2 неіснуючі послуги, і саме ця перевірка їх відкинула.
- Месенджери детектяться за маркерами (`wa.me`, `viber://`, слово поруч із номером), а не припускаються: наявність телефону НЕ означає WhatsApp.
- Дедуп: place_id → телефон → домен → name+geo. Дублікат приєднує source, а не створює бізнес.
- Website audit: повна матриця http/https × www/non-www + реальний браузер + mobile. Одна TLS-помилка ≠ «сайту нема».
- Qualification ≠ priority score ≠ production readiness. Gaps блокують генерацію нечесного демо.
- Builder бачить тільки immutable snapshot. Бракує контенту → пакет назад на enrichment, а не фантазія.
- QA-ліміт ітерацій → `needs_human_review`, без нескінченних циклів.
- Outreach: без записаного approval send неможливий; окремий idempotency key на кожен send; daily limit; do_not_contact перевіряється в момент відправки; opt-out назавжди блокує контакт.
- Падіння одного бізнесу ніколи не зупиняє кампанію (retries + dead-letter в `workflow_jobs`).

## Структура

```text
src/
  db/            schema (17 таблиць), клієнт, міграції
  orchestrator/  statuses (state machine), queue (pg-boss), router (переходи етапів)
  agents/        спільний runtime API + remote transport до ізольованого runner
  runner/        gateway/executor protocol, workspace sync, health і secret gate
  enrichment/    gosomEvidence (майнінг CSV доказів), messengers (детекція
                 каналів), capture (Playwright + immutable raw), grounding
                 (анти-галюцинаційна перевірка тверджень агента)
  workers/       discovery, normalize, fastQualify, enrich, assets, audit,
                 score, readiness, contentDesign, snapshot, builder, visualQa,
                 deploy, approval, outreach, replies, summary
  telegram/      notification-only повідомлення з лінками у Web UI
  api/           internal commands/checks + JSON API + demo server + WhatsApp webhook
scripts/smoke.ts детермінований смоук-тест пайплайна
```

## Тести

```bash
pnpm typecheck
pnpm tsx scripts/smoke.ts   # campaign -> normalize -> dedup -> qualify -> audit -> gaps -> queue
pnpm release:gate -- --quick # локальний цикл; не є дозволом на deploy
pnpm release:gate            # повний release contract + evidence JSON

# етапи 2-8 (фаза B), без мережі й без агентів:
pnpm tsx scripts/phaseB-test-detect.ts       # 29 тестів: месенджери/соцмережі
pnpm tsx scripts/phaseB-test-grounding.ts    # 42 тести: анти-галюцинації
pnpm tsx scripts/phaseB-test-stages.ts <csv> # 37 тестів: етапи 3/5/8 + парсер gosom
pnpm tsx scripts/phaseB-test-contradiction.ts # гілка суперечності аудиту (потребує БД)
```

Реальний прогін етапів 2-8 і звіт по цілісності доказів:

```bash
pnpm tsx scripts/phaseB-run.ts gr-patras-beauty --workers
pnpm tsx scripts/phaseB-verify.ts gr-patras-beauty
pnpm tsx scripts/phaseB-sample-evidence.ts <businessId>
```

Деталі етапів 2-8: [`docs/PIPELINE-STAGES-2-8.md`](docs/PIPELINE-STAGES-2-8.md).
Безпечний production cutover і recovery: [`docs/PRODUCTION-ROLLOUT.md`](docs/PRODUCTION-ROLLOUT.md).

## Поточні архітектурні рішення

1. **n8n немає**: оркестрація — власний код (state machine + pg-boss). Причина: тестованість, версіонування, один стек.
2. **Redis немає**: pg-boss живе в Postgres. Queue mode «вмикається» кількістю процесів workers.
3. **Builder = workspace-агент з Next.js-шаблоном**, стек як у спеці (Next.js + TS, static export). Одношотного API-fallback немає: вибраний у UI підписковий runtime (Claude Code або Codex) застосовується до всіх агентних етапів.
4. **Deploy v1 = вбудований static server** з noindex і неугадуваними URL; Dokploy-адаптер є як опція.

Все інше (модель даних, статуси, gates, правила evidence, межі автоматизації) відповідає специфікації.
