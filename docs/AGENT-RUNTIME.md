# Агентний рантайм: тільки по підписці

Реалізація спеки §2.3 і рішення №10. **`ANTHROPIC_API_KEY` не потрібен, не читається і не передається в жоден процес.** Пакет `@anthropic-ai/sdk` (pay-per-token) видалений з залежностей.

## Три рантайми, один інтерфейс

| Рантайм | Оплата | Аутентифікація |
|---|---|---|
| `claude-code` (default) | підписка Claude Pro/Max Романа | UI запускає `claude setup-token` у runner; токен у runner credential volume |
| `codex` | підписка ChatGPT | UI запускає `codex login`; credential у runner `$CODEX_HOME` |
| `opencode` | підписка провайдера, залогіненого в opencode (Kimi, Zen, …) | `docker compose exec agent-runner-executor opencode auth login`; у production дозволений лише tool-free `structured()` |

Усі реалізують `AgentRuntime` (`src/agents/types.ts`):

```ts
structured(name, systemPrompt, userContent, zodSchema, opts) -> T   // headless, без інструментів
codeAgent(opts, resultSchema) -> T                                  // workspace + інструменти, результат через result.json
// + capability-методи для transports:
label / rateLimitFromText() / terminalLaunch() / prepareTerminal?() / authEnv()
```

Публічний API для воркерів не змінився:

```ts
import { runAgent, z } from '../agents/agent.js';        // structured
import { runCodeAgent } from '../agents/codeAgent.js';   // workspace
```

Обидва модулі — тонкі фасади над `src/agents/runtime.ts`, де живе реєстр
`RUNTIMES`. Додавання нового harness'а — чекліст на початку того файлу.

## Файли

| Файл | Що робить |
|---|---|
| `src/agents/types.ts` | інтерфейс `AgentRuntime`, `RateLimitedError`, `AgentSchemaError`, типи опцій, `RUNTIME_LABELS` |
| `src/agents/modelPolicy.ts` | політика моделей (`effectiveModels`) + союз `AgentRuntimeId`. Без жодного імпорту: копіюється в UI-образ разом із settings.ts |
| `src/agents/runtime.ts` | реєстр рантаймів (`RUNTIMES`, `getRuntime`, `getRuntimeById`) + публічні `runAgent` / `runCodeAgent` |
| `src/agents/claudeCodeRuntime.ts` | адаптер Claude Code (Agent SDK) + його термінальні потреби: guard через `--settings`, pre-trust workspace |
| `src/agents/codexRuntime.ts` | адаптер Codex CLI (`codex exec`) |
| `src/agents/opencodeRuntime.ts` | адаптер OpenCode CLI (`opencode run --format json`, NDJSON-події, guard через OPENCODE_CONFIG) |
| `src/agents/result.ts` | контракт `result.json`: читання + валідація, спільний для всіх адаптерів і обох транспортів |
| `src/agents/ratelimit.ts` | спільні сигнатури вичерпання підписки у вільному тексті + фабрики `RateLimitedError` |
| `src/agents/retry.ts` | спільний retry-цикл `structured()` (rate-limit не витрачає спробу, фінал — `NEEDS_HUMAN`) |
| `src/agents/schema.ts` | zod → JSON Schema, стійкий парсер JSON з відповіді |
| `src/agents/semaphore.ts` | обмеження конкурентності агентних викликів |

### Як додати новий harness (чекліст)

1. Реалізуй `AgentRuntime` у новому файлі-адаптері. Спільна механіка вже є:
   результат — `result.ts`, ліміти — `ratelimit.ts`, retry — `retry.ts`,
   моделі — `modelPolicy.ts`, env-allowlist — `sandbox.ts`.
2. Зареєструй його в `RUNTIMES` (`runtime.ts`) та додай id у союз
   `AgentRuntimeId` (`modelPolicy.ts`) і `RUNTIME_LABELS` (`types.ts`).
3. Розшир опції селекта `AGENT_RUNTIME` (`src/lib/settings.ts`) та
   `normalizeRuntime` (`src/config.ts`).
4. Якщо CLI має інтерактивний логін — додай флоу в `src/api/accounts.ts`
   (PTY через `script -q`, як у claude; plain spawn, як у codex) і картку в
   `ui/components/ConnectedAccounts.tsx`.

Більше ніщо не гілкується за id рантайму: tmux-транспорт, черга, перевірки й
консоль ідуть через capability-методи інтерфейсу (`terminalLaunch`,
`prepareTerminal?`, `authEnv`, `rateLimitFromText`, `label`).

## Як зроблено structured output

**Claude Code:** нативно через Agent SDK — `outputFormat: { type: 'json_schema', schema }` (є в `@anthropic-ai/claude-agent-sdk` 0.3.233), результат читається з `result.structured_output`. Плюс `allowedTools: []`, turn budget (див. нижче), `permissionMode: 'bypassPermissions'`, `settingSources: []` (щоб проєктні CLAUDE.md/скіли не втручались у витяг фактів). У промпт додатково вкладається JSON Schema — якщо `structured_output` порожній, парситься фінальний текст (зняття ```-огорожі, збалансований span з урахуванням лапок). Невалідний JSON/схема → retry (за замовчуванням 3 спроби), далі `AgentSchemaError` з кодом `NEEDS_HUMAN` (спека §7: schema failure не крутиться в retry-циклі).

**Codex:** `codex exec --output-schema <file> --output-last-message <file> --ephemeral`; у production CLI отримує runner-owned exact-root profile `factory-read-only`, у локальній розробці — legacy `--sandbox read-only`. JSON береться з останнього повідомлення агента і валідується тією ж zod-схемою.

**OpenCode:** `opencode run --format json` без нативного schema-прапора — контракт JSON вкладається в промпт (`jsonOnlyInstruction`), відповідь — останній `text`-івент, парситься тим самим `extractJson`. Помилки стріму класифікуються в `errorFromEvents`: statusCode 401/402/429 чи "payment required" → `RateLimitedError` (пауза), інше → звичайна помилка.

**Мультимодальність (visual QA):** скриншоти пишуться у тимчасову теку, агенту дозволяється лише `Read` і передаються шляхи до файлів — картинки читає він сам. Жодних base64-payload'ів в API.

## Моделі

Два поля моделей у UI належать вибраному runtime. Правило відображення/передачі
— одна функція `effectiveModels()` (`src/agents/modelPolicy.ts`), яку читають і
адаптери, і `/api/checks`, і сторінка налаштувань (копія файлу в UI-образі):

- дефолтний рантайм (`claude-code`) отримує поля як є, з реєстровими
  дефолтами;
- будь-який інший рантайм трактує "значення прийшло з дефолту реєстру" як
  НЕЗАДАНЕ: Claude-типові дефолти ніколи не потрапляють у чужий CLI, а одне
  збережене звичайне значення покриває і heavy-рівень, поки heavy не заданий.

```
AGENT_MODEL=claude-sonnet-5        # enrichment, QA, content, outreach
AGENT_MODEL_HEAVY=claude-opus-5    # builder, design, visual critique
```

Для Codex ці самі поля передаються як `codex exec --model …`; якщо нічого не
збережено, `--model` не передається і діє типова модель Codex CLI.

## Вибір рантайму

```bash
AGENT_RUNTIME=claude-code      # глобально: claude-code | codex | opencode
```

Вибір один і застосовується до `enrichment`, `qa`, `content`, `design`,
`outreach`, `builder` та `visual-critique`. Старі приховані
`AGENT_RUNTIME_<KIND>` більше не читаються: значення на сторінці налаштувань є
джерелом істини. `config.agents.runtimeFor(kind)` лишається типізованою точкою
маршрутизації. Значення `api` більше не існує — якщо воно лишилось у старому
`.env`, код друкує попередження і використовує `claude-code`, а не вмикає
API-білінг.

## Turn budget і рятування результату

`structured()` більше не прибитий до одного ходу. Дефолт — **2** ходи без інструментів (`maxTurns` у `StructuredOptions` перевизначає; з картинками додається хід на кожен Read). Причина: один хід вистачає для малої схеми, але великий structured-вихід (наприклад 3 повні art directions проти ~24KB промпту) інколи дописується на другому ході, і `error_max_turns` вбивав нормальний прогін. При `allowedTools: []` зайвий хід не дає агенту зробити жодної дії — тільки дописати відповідь.

**Окремий баг, полагоджений разом:** Agent SDK перетворює ненульовий вихід процесу з error-результатом на **throw** `Claude Code returned an error result: ...` (`Query.readMessages`). Через це `collectRun` не повертався, і повністю валідна відповідь, дописана на останньому ході, викидалась, а виклик спалював усі retry. Тепер:

- якщо `result`-повідомлення вже прийшло (`sawResult`), payload зберігається, а throw не пропускається далі;
- `structured()` приймає відповідь, якщо вона **валідується схемою**, навіть коли підтип сесії `error_max_turns` (у лог іде warning);
- `codeAgent()` перед тим, як оголосити падіння, перевіряє `result.json` на диску — артефакт є контрактом; якщо він валідний, сесія вважається успішною.

Rate-limit і timeout лишаються справжніми помилками і пропускаються далі як були.

Регресія закріплена: `pnpm tsx scripts/test-agent-salvage.ts` (реальні виклики) — форсує `error_max_turns` на агенті, який уже записав `result.json`, і перевіряє, що результат врятовано.

## Skills і налаштування у workspace-агента

`codeAgent()` приймає `skills?: string[] | 'all'` і передає їх в Agent SDK. Це **єдине місце, де скіли вмикаються** — `'Skill'` у `allowedTools` застаріле. Пропущене значення ≠ "скіли вимкнені": діють дефолти CLI. Builder передає `skills: 'all'`, бо в його workspace лежать офіційні GSAP-скіли (`<workspace>/.claude/skills/gsap-*`, спека §2.4 / рішення №11).

Застереження SDK: це **фільтр контексту, а не пісочниця** — невключені скіли ховаються зі списку, але їхні файли лишаються читабельними через Read/Bash. Для нас нормально: там публічна GSAP-документація, без секретів.

**Свідома асиметрія `settingSources`:**

| | `structured()` | `codeAgent()` |
|---|---|---|
| `settingSources` | `[]` (повна ізоляція) | `['project']` |

Витяг фактів має бути незалежним від будь-якого local config, тому там `[]`. Workspace-агенту, навпаки, потрібен власний `<cwd>/.claude/` — саме там живуть GSAP-скіли. Але завантажується **тільки `project`**, не `user`: персональний `~/.claude` оператора фабрики не повинен впливати на те, як збирається сайт клієнта. Оскільки cwd — це `sites/<biz>/`, кореневий CLAUDE.md фабрики туди не потрапляє.

## Ізоляція workspace-агента (безпека)

Builder працює без ручних permission prompt-ів (він мусить сам ставити пакети і робити білди), але JS-guard — лише defense in depth. Production boundary складається з кількох незалежних шарів:

**1. Allowlist змінних оточення.** Процес фабрики тримає SMTP/IMAP-паролі, Telegram-токен, S3-ключі і `DATABASE_URL`. Агенту передається **тільки явний список**: `PATH`, `HOME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`/`LC_*`, `NODE*`/`PNPM_*`/`NPM_CONFIG_*`/`COREPACK_*`, `HTTP(S)_PROXY`/`NO_PROXY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_HOME`. Все інше відкидається, плюс окремий denylist (`SMTP_`, `IMAP_`, `TELEGRAM_`, `WAHA_`, `S3_`, `AWS_`, `DATABASE_`, `UI_`, `ANTHROPIC_`, `OPENAI_`, …) як другий пояс. Те саме застосовано до Codex-адаптера і до `structured()` — немає причин показувати секрети моделі, яка обробляє чужий скрейпнутий текст.

**2. PreToolUse-guard.** Кожен виклик інструменту звіряється з межами workspace: Read/Write/Edit/Glob/Grep поза `cwd` (з `realpath`, тому `..` і симлінки не рятують) — deny; Bash із мережевими командами (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`…) до немережевого loopback — deny; звернення до `~/.ssh`, `~/.aws`, `~/.config`, `.env`, `/etc/passwd` — deny. `pnpm`/`npm`/`npx`/`node`/`next`/`tsc` і доступ до пакетних реєстрів дозволені, бо це і є робота білдера. Guard fail-closed: якщо він сам кинув помилку, виклик забороняється.

> **Важливо для тих, хто це рефакторитиме:** `canUseTool` тут НЕ працює. Під `bypassPermissions` SDK авто-схвалює кожен виклик до колбека і друкує `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`; навіть під `permissionMode: 'default'` голі імена в `allowedTools` перекривають колбек. Перевірено емпірично на 0.3.233: файл записався попри `deny`-колбек. Працює саме **PreToolUse hook** — його `deny` дотримується. Не «спрощуй» це назад до `canUseTool`: guard мовчки перестане існувати.

**3. Native tool sandbox.** Claude SDK отримує `sandbox.enabled=true`, `failIfUnavailable=true`, exact workspace read/write, deny для всього runner root, auth і `/proc`, credentials deny та strict network allowlist. Codex використовує runner-owned profiles у `$CODEX_HOME/config.toml`: весь `/app/runner-work` прихований, назад відкривається тільки поточний workspace; package store повертається лише tool/package profiles. `TMPDIR` теж лежить усередині workspace. Якщо native sandbox не стартує, readiness executor-а падає і gateway/factory не запускаються.

**4. Docker/мережевий периметр.** Executor не підключений до звичайної Compose-мережі й не має default gateway. Він бачить тільки дві `internal: true` мережі: gateway-control та runner-egress. Public DNS проходить через CoreDNS, який forward-ить лише provider/package zones; HTTP(S) — через Squid, який дозволяє тільки затверджені provider/package domains і відсікає private/link-local/direct-IP/довільний CONNECT. `node fetch`, Python urllib без proxy, raw sockets, arbitrary DNS, Postgres/MinIO/factory/host і Docker socket недоступні. Root FS read-only, capabilities скинуті, `no-new-privileges`, PID/memory limits; auth — у nested named-volume overlays, яких gateway не монтує.

**5. Output gate.** Значення credentials завантажуються тільки в coordinator memory, рекурсивно маскуються у structured logs/build-log і перед sync шукаються в output як точні byte sequences. Збіг або symlink/special file → `SECURITY_VIOLATION`; gateway у такому випадку не синхронізує жоден output назад у factory storage.

OpenCode 1.18 має permission rules, але не має enforceable OS sandbox для tool subprocesses. Тому production gate свідомо дозволяє його tool-free `structured()`, але відхиляє `codeAgent()` до запуску. Для builder/QA-fix треба обрати Claude Code або Codex. Це fail-closed compatibility rule, а не тимчасовий fallback.

> **Другий транспорт того самого гарда.** Коли збірка йде в tmux (`BUILDER_MODE=tmux`, див. `docs/BUILD-PIPELINE.md`), агент — це інтерактивний CLI, а CLI вміє тільки *командний* хук, не JS-замикання. Тому `src/agents/guardHook.ts` загортає ту саму `evaluateToolCall()` у процес «payload зі stdin → рішення в stdout» і вмикається через `--settings`. Рішуча функція одна на два шляхи; різниця тільки в транспорті, і `pnpm test:tmux-agent` звіряє їх на однакових входах, щоб tmux-шлях не став мовчки нергардженим. Хук fail-closed так само: нечитабельний payload, відсутній аргумент воркспейсу чи виняток — усе deny.
>
> PreToolUse-хуки спрацьовують **до** перевірки permission-mode, тому `deny` тримається і під `--dangerously-skip-permissions` — та сама властивість, на якій тримається SDK-шлях.

Перевірка: `pnpm tsx scripts/test-agent-sandbox.ts` і `--live` (реальний агент пробує вкрасти `~/.ssh` і писати поза workspace); `pnpm test:tmux-agent` — паритет CLI-хука з SDK-гардом; `pnpm test:runner-isolation` — реальні Compose-проби network/auth/workspace/output boundaries.

## Метрики використання (§9)

Обидві операції приймають необов'язковий `onUsage(usage)`, який викликається раз на сесію:

```ts
{ runtime: 'claude-code', model: 'claude-sonnet-5', numTurns: 4, costUsd: 0.144, durationMs: 9102 }
```

Це дає спеці §9 "QA-ітерації" і "cost per demo" на кожну ітерацію білда. `costUsd` — оцінка споживання підписки самим рантаймом, **не рахунок**: pay-per-token тут немає. Колбек best-effort: якщо він кине помилку, агентний виклик не падає (пишеться warning).

## Ліміти підписки як частина дизайну (§2.3)

**Детекція.** Agent SDK віддає окреме повідомлення `rate_limit_event` з `rate_limit_info: { status, resetsAt, rateLimitType }`. `status === 'rejected'` = вікно вичерпане. Додатково ловляться typed-помилки асистента (`rate_limit`, `overloaded`), HTTP 429 і текстові сигнатури ("rate limit", "usage limit", "you've hit your limit") — тепер ОДИН спільний список у `src/agents/ratelimit.ts` для всіх адаптерів і для tmux-скролбека (через `runtime.rateLimitFromText()`; раніше списки були продубльовані й розійшлися).

**Реакція.** Кидається `RateLimitedError { retryAfterMs, rateLimitType, resetsAt }`. `retryAfterMs` рахується з `resetsAt` (+30 c запасу, обрізається `AGENT_RATE_LIMIT_MAX_WAIT_MINUTES`, дефолт 6 год), інакше `AGENT_RATE_LIMIT_WAIT_MINUTES` (дефолт 15 хв).

**У черзі** (`src/orchestrator/queue.ts`): job переходить у **`retry_wait`** з `next_attempt_at`, лічильник `attempts` відкочується (ліміт падінь не витрачається), job перезапускається з **тим самим idempotency key** через `startAfter`, у Telegram іде повідомлення "це не помилка, черга продовжить сама". `failed` при вичерпаному ліміті не буває ніколи.

Колонка `workflow_jobs.next_attempt_at` додана міграцією `drizzle/0001_dark_mulholland_black.sql`.

## Конкурентність

Factory передає worker-group і її актуальний ліміт у кожному runner request. Executor відновлює окремі `core` / `enrich` / `build` семафори через `withAgentSlot`; attachable terminal додатково має окремий ліміт 1 через єдиний ttyd-порт. Другий пояс: агентні типи jobs (`enrich`, `score-and-qa`, `content-and-design`, `build-site`, `visual-qa`, `request-approval`) реєструються в pg-boss з `teamSize: 1, batchSize: 1`, і їм дається довший `expireInSeconds` (90 хв), бо збірка сайту з `pnpm build` довга.

## Docker

Окремий `Dockerfile.runner` ставить усі три CLI в executor (версії піновані):

```dockerfile
RUN npm i -g @anthropic-ai/claude-code@2.1.239 @openai/codex@0.149.1 opencode-ai@1.18.23
ENV CODEX_HOME=/app/runner-work/.private/codex
ENV OPENCODE_DISABLE_AUTOUPDATE=1
USER node          # НЕ hardening: --dangerously-skip-permissions відмовляється працювати під root
```

Claude token пишеться account-flow у runner-owned volume файлом `0600`. Codex і
OpenCode мають окремі `codexhome` / `opencodehome` volumes. Factory-контейнери
не монтують жоден із них і не містять provider CLI.

Фактичний production path для Codex — `/app/runner-work/.private/codex`, для
Claude credentials — `/app/runner-work/.private/credentials`, для OpenCode —
`/app/runner-work/.private/provider/opencode`. Це nested volume
overlays: executor бачить credential, gateway у своєму `runnerwork` — ні.

Плюс два бінарники для термінала збірки: `tmux` (з apt) і `ttyd`. **ttyd ставиться
не через apt**, а як пінований статичний бінарник із перевіркою sha256: його немає
в жодному стабільному suite Debian (тільки sid), тож `apt-get install ttyd` на
bookworm просто впаде і забере з собою весь білд образу. Обидві архітектури
(amd64/arm64) прописані, бо фабрика крутиться і на x86-сервері, і на маку Романа.

## Перевірка

```bash
pnpm tsx scripts/test-agent-parsing.ts     # парсинг, схеми, реєстр, моделі, rate-limit, семафор (без мережі)
pnpm tsx scripts/test-rate-limit-requeue.ts # retry_wait проти реального Postgres/pg-boss
pnpm tsx scripts/test-agent-salvage.ts     # рятування результату при error_max_turns (реальні виклики)
pnpm tsx scripts/test-agent-sandbox.ts     # env-allowlist + guard (33 офлайн); --live = реальна атака
pnpm tsx scripts/verify-agent-runtime.ts   # реальні виклики по підписці
AGENT_RUNTIME=codex pnpm tsx scripts/verify-agent-runtime.ts
AGENT_RUNTIME=opencode AGENT_MODEL=opencode/x-preview-f-free pnpm tsx scripts/verify-agent-runtime.ts
pnpm tsx scripts/test-tmux-agent.ts --live-opencode  # реальна tmux-сесія opencode TUI
pnpm test:agent-runner                 # protocol + gateway/executor + sync, без підписок
pnpm test:runner-isolation              # реальний Compose: egress/DNS/raw sockets/auth/workspaces/readiness
```

## Групи воркерів і capacity через runner (оновлено 2026-08-28)

`AGENT_CONCURRENCY` і `withAgentSlot` обмежують агентні виклики **в межах одного
процесу**. Поки `startWorkers()` реєстрував усі типи jobs, це означало спільну
FIFO-чергу: 40-хвилинна сесія `build-site` або блокувала бек-лог `enrich`, або
сама ставала в чергу за ним (реально спостережено: 126 `enrich` у черзі, білд не
стартував 50 хвилин).

Factory і надалі реєструє jobs групами `core` / `enrich` / `build`:

```bash
pnpm workers                      # усі групи (дефолт, локальна розробка)
pnpm workers --only=core,enrich   # контейнер factory
pnpm workers --only=build         # контейнер factory-build
WORKER_GROUPS=build pnpm workers  # те саме через env
```

Factory передає назву поточної групи й її ефективний ліміт у runner request.
Executor відновлює три незалежні семафори, тому один довгий `build` не забирає
слот у `enrich`, хоча provider CLI централізовані. Розклади реєструє тільки
`core`. Деталі груп і сервісів compose — `docs/BUILD-PIPELINE.md` §11.

Перемикання `AGENT_RUNTIME=codex` у UI кладе всі агентні етапи на підписку
ChatGPT. Поточний runtime і фактичні normal/heavy моделі можна запитати прямо
на сторінці «Агенти»; відповідь приходить із живого процесу factory.

## Мова нотаток: український шар над агентним текстом (рішення Романа, 2026-08-20)

Роман читає консоль українською, але два потоки вільного тексту українськими
бути не можуть у момент, коли їх пишуть:

- **soft gaps з enrichment.** Промпт (`enrich.ts`, правило 5) вимагає лишатись у
  мові доказів — саме це не дає моделі «перекласти» слова бізнесу в маркетинг.
  Для Патр докази грецькі, тому й пропуски грецькі: «Δεν εντοπίστηκε επίσημος
  ιστότοπος…». Виправлення — окремий прохід перекладу, а не змінений промпт.
- **зауваження незалежного QA-критика.** Англійська там навмисна: критик — інша
  персона, що міркує про походження фактів, а не про бізнес.

`src/lib/translateNotes.ts` перекладає їх **на запису**, одним пакетним викликом
`runAgent` на бізнес, у паралельну колонку. Оригінал ніколи не перезаписується —
це доказ того, що агент справді сказав, і UI тримає його на одну згортку далі.

| Поле | Колонка з перекладом | Хто пише |
|---|---|---|
| `production_gaps.gap` | `gap_uk` | `enrichHandler` |
| `qualifications.qa_notes` | `qa_notes_uk` | `scoreAndQaHandler` |
| `website_audits.notes` | — (див. нижче) | — |

**`website_audits.notes` колонки не має і не потребує.** Кожен рядок у ньому
складений з наших власних шаблонів у `src/workers/audit.ts` (`slow render (6.4s
to settle)`, `generator=WordPress 6.9.4`), тому його рендерить код —
`ui/lib/auditNotes.ts` — а не модель. Наслідки: жодного виклику підписки на
вгадування власного формату, усі старі рядки стають українськими одразу без
бекфілу, а в БД лишається англійська, яку `src/build/snapshot.ts` віддає
білдер-агенту (англомовній персоні, чий вхід не можна псувати заради мови
консолі).

Три властивості перекладу, які тримаються навмисно:

1. **Не фатальний.** Помилка перекладу → `null` у колонці + warning; UI показує
   оригінал. Неперекладений пропуск — косметика, зірваний enrichment — ні.
2. **Модель не викликається без потреби.** Текст, що вже кирилицею, проходить
   повз (`isCyrillic`), а наші власні ключі (`logo_missing`,
   `socials_unresolved`, `brand_unresolved`) мають словник у коді.
3. **Пакет із розбіжною кількістю рядків відкидається цілком.** Зсунутий на один
   переклад приписав би пропуск одного бізнесу іншому — це гірше, ніж переклад
   відсутній.

Бекфіл наявних рядків (ідемпотентний, тільки `NULL`):

```bash
pnpm tsx scripts/translate-notes.ts --campaign gr-patras-beauty-2026-08
pnpm tsx scripts/translate-notes.ts --dry-run --limit 10   # подивитись, нічого не писати
```

Юніт-перевірки рендера (без БД і без агента): `pnpm tsx scripts/test-notes-uk.ts`.
