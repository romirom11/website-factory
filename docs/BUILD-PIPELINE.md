# Phase C: brief → design → build → QA → private deploy

Реалізація спеки §4 (етапи 9-12), §2.3, §2.4, §2.5 і рішень №5, №11, №12, №13.
Модулі: `src/build/**`, воркери `src/workers/{contentDesign,builder,visualQa,deploy}.ts`,
`src/lib/serveDir.ts`.

**Головний принцип фази:** агент пише сайт, але **код перевіряє результат**. Жоден
самозвіт агента ("я зібрав, все зелено") не приймається на віру: `pnpm build`
переганяється незалежно, а зібраний HTML грепається проти snapshot.

---

## 1. Потік

```text
production_ready
  → [build policy gate]             ← кампанія вирішує, чи взагалі збирати
  → content-and-design  (stage 9)   site_in_progress
  → build-site          (stage 10)
  → visual-qa           (stage 11)  ─┐ issues → назад у build-site (той самий workspace)
  → deploy-demo         (stage 12)  ←┘ чисто
  → site_ready → request-approval (фаза D)
```

Ліміт QA-ітерацій — `MAX_QA_ITERATIONS` (3). Вичерпано → `site_projects.state =
needs_human_review`, бізнес у `needs_review`, job у `needs_human` (не failed,
без retry-шторму), пуш у Telegram.

### Build policy gate (перед stage 9)

`production_ready` більше **не** означає автоматичний запуск збірки. Рішення
Романа: спершу сайти тим, у кого сайта немає — інакше 40 хвилин підписки йдуть
на лід із уже робочим сайтом.

`src/orchestrator/buildPolicy.ts` — чиста логіка рішення, **спільна** з UI
(`ui/factory/buildPolicy.ts` — симлінк, як і схема БД), щоб роутер і кнопка
«Будувати демо» не могли розійтись у трактуванні. `advance()` перед
`content-and-design` читає `campaigns.auto_build` і **останній** вердикт
`website_audits`:

| `auto_build` | Умова enqueue |
|---|---|
| `no_site_only` (типово) | вердикт ∈ {`no_website`, `broken`} |
| `all` | завжди |
| `manual` | ніколи |

Відсутній аудит = **не** eligible при `no_site_only`. Неприйнятний бізнес
лишається в `production_ready` (стан машини не чіпається) і чекає кнопки в UI.

Пріоритет pg-boss: `buildJobPriority()` = тир вердикту (300/200/0) +
`round(score × 0.9)`. Score затиснутий у 0-100, тож тир ніколи не перебивається
скором — «зовсім без сайту» завжди попереду.

Перевірки: `pnpm tsx scripts/test-build-policy.ts` (чиста логіка, 12 кейсів) і
`pnpm tsx scripts/test-router-build-gate.ts` (проводка через реальну БД, сам за
собою прибирає).

## 2. Файли

| Файл | Роль |
|---|---|
| `src/build/snapshot.ts` | **Frozen build snapshot** — заморожений пакет доказів, який бачить білдер. Надмножина `ClientSnapshot` фази B: контакти рядками, source_id на кожен факт, `ai_generated` на кожному ассеті, вердикт аудиту, відкриті gaps. |
| `src/build/schemas.ts` | Zod-контракти всіх агентних виходів + списки грекостійких шрифтів. |
| `src/build/rubric.ts` | **Детермінований вибір напряму.** Ваги, штрафи, hard-вето. Жодного виклику моделі. |
| `src/build/provenance.ts` | **Грепає зібраний HTML проти snapshot**: телефони, email, зовнішні лінки, `<img src>`, noindex, alt AI-картинок. |
| `src/build/workspace.ts` | Готує ізольований workspace + пише `BUILD-TASK.md` (правила пише код, не модель). |
| `src/build/media.ts` | Hero-кліп і декоративний фон. Обидва **не можуть завалити білд**. |
| `src/lib/serveDir.ts` | `serveDir()` для QA + `startDemoServer()` для приватних демо. |

## 3. Stage 9 — brief + design (`contentDesign.ts`)

Три headless-виклики, потім **рішення кодом**:

1. **content brief** (`kind: content`) — тільки з snapshot. Кожен `allowedClaim`
   несе `snapshotPath` і скопійовані `sourceIds`. Немає доказу → `forbiddenClaims`
   або `omissions`. Уся видима копія — мовою бізнесу.
2. **3 art directions** (`kind: design`, heavy) — структурно різні: інший hero-девайс,
   інший ритм секцій, інший зв'язок типографіки й фото. Кожен називає **рівно один**
   референс з `references/<niche>/README.md` і конкретні механіки, які позичає.
3. **critique** (`kind: qa`, heavy) — окремий агент ставить 0-10 по осях. **Він не
   обирає переможця.**

Потім `chooseDirection()` рахує:

```
score = 0.28·distinctiveness + 0.24·evidenceFit + 0.20·typographicCraft
      + 0.14·referenceGrounding + 0.14·motionRestraint
      − 3.3·(slopRisk/10) − 1.5·(buildRisk/10) − 3·(кількість вето)
```

**Hard-вето (код, поверх думки критика):**

- шрифт без грецького сабсету на грецькому сайті (це **hard build failure** у
  `next/font`, не тихий фолбек);
- display-шрифт з ban-list (Inter/Poppins/Montserrat/Roboto/Open Sans/Lato/Nunito);
- hero обіцяє реальне фото, але файлу немає в snapshot;
- hero-фото насправді `ai_generated` (інваріант CLAUDE.md);
- більше 4 компонентів з пулу;
- секція відгуків при нулі верифікованих відгуків.

Одне вето коштує 3 бали — більше за будь-який реалістичний розрив в оцінках критика,
тому «впевнено описаний зламаний напрям» виграти не може. Нічия розв'язується
детерміновано (distinctiveness, потім порядок) — той самий вхід дає той самий сайт.

Заморожується в storage: `snapshot`, `brief`, `design` (з повним ranking і rationale).

## 4. Stage 10 — build (`builder.ts` + `workspace.ts`)

Workspace: `sites/<businessId>/<projectId>/`

```text
package.json, app/, components/, lib/, DESIGN.md   ← копія site-template
pnpm-workspace.yaml                                 ← install лишається self-contained
input/{snapshot,brief,design,rubric}.json
public/assets/**        реальні фото (можуть зображати бізнес)
public/generated/**     AI-медіа (тільки декор)
MEDIA-MANIFEST.json     хто що може стверджувати про кожен файл
.claude/skills/gsap-*   офіційні GSAP-скіли (вмикаються `skills: 'all'`)
references/<niche>/     курований пак референсів
BUILD-TASK.md           жорсткі правила — пише КОД
```

`node_modules`, `.next`, `out` не копіюються. Стале `result.json` видаляється, щоб
не бути прочитаним як вихід цього прогону.

### Як саме запускається агент: `sdk` чи `tmux`

Рішення Романа 2026-08-22: «Я питав про можливість підключення до термінальної
сесії». Стрічка подій у картці (`LiveBuildPanel`) — це **переказ** того, що робив
агент; вона не замінює живий термінал. Тому агент збірки має два режими,
`BUILDER_MODE` у `/settings`:

| режим | що це | коли |
|---|---|---|
| `tmux` (типово) | інтерактивний `claude` у tmux-сесії `build-<projectId>`, яку `ttyd` віддає в браузер | завжди, коли на хості є tmux |
| `sdk` | безголова SDK-сесія, як було | явний вибір, або **автоматично**, якщо tmux не встановлений |

Перемикання прозоре для пайплайна: та сама `CodeAgentOptions`, той самий контракт
`result.json`, ті самі помилки, той самий build-log. Фолбек на `sdk` — не помилка:
на машині без tmux збірки мусять просто працювати.

Що довелось вирішити в `tmuxRuntime.ts`, бо TUI — не SDK:

- **Промпт не набирається з клавіатури.** Промпт білдера — кілька КБ Markdown;
  через `send-keys` це лапки, переноси рядків і TUI, що починає виконувати
  півпромпта. Тому промпт **пишеться у файл** `AGENT-PROMPT.md`, а в сесію йде
  один короткий рядок «прочитай цей файл і виконай».
- **Гард мусив стати процесом.** SDK-шлях передає PreToolUse як JS-замикання;
  CLI вміє тільки *команду*. `src/agents/guardHook.ts` — та сама
  `evaluateToolCall()`, але читає payload зі stdin і віддає рішення в stdout;
  вмикається через `--settings` (не через `.claude/settings.json` воркспейсу:
  воркспейс деплоїться, і `--settings` має вищий пріоритет, тож шаблон не може
  роззброїти гард). `pnpm test:tmux-agent` звіряє обидва гарди на однакових
  входах — паритет перевіряється, а не припускається.
- **Завершення — це артефакт, а не проміс.** TUI нічого не резолвить, тому
  ознакою кінця лишається наявний контракт: у воркспейсі зʼявився `result.json`.
  Окремо стежимо, чи змінюється pane, щоб відрізняти «закінчив» від «помер».
- **Скролбек зберігається.** Перед killом сесії повна історія pane пишеться у
  `terminal.log` поруч із build-log — це те, що Роман читає постфактум.

Веб-термінал (`src/agents/terminalServer.ts`): один `ttyd` в runner executor;
attachable сесії серіалізуються окремо від headless-викликів. Basic auth з паролем, **похідним** від
`INTERNAL_API_KEY` (не самим ключем), і `tmux attach -r` — тільки перегляд.
`BUILD_TERMINAL_WRITABLE=true` знімає `-r` і дає друкувати живому агенту; типово
**вимкнено**, бо такий дотик змінює демо клієнта без approval і без сліду в
історії, тоді як усі інші зміни у фабриці мають і те, і те.

Оскільки tmux живе в `agent-runner-executor`, а API відповідає з `factory`,
статус іде через authenticated runner gateway. Він читає маркер
`terminal-session.json` тільки з per-invocation scratch. Маркер має heartbeat: якщо executor убили,
застарілий маркер читається як «сесії немає», а не як вічне посилання в нікуди.

**Після агента код перевіряє:**

1. `out/index.html` існує;
2. `pnpm build` переганяється **незалежно** — не зелений = job падає;
3. `checkProvenance(out, snapshot)`.

Provenance-знахідки **не валять job** — вони їдуть у QA як issues і повертаються
агенту в тому ж циклі, що й візуальні. Це навмисно: вигаданий телефон — це дефект
сайту, а не збій пайплайна.

### Що ловить provenance-чек

| kind | Що це |
|---|---|
| `foreign-phone` | `tel:` або видимий телефон, якого немає в контактах snapshot |
| `foreign-email` | email не з snapshot |
| `foreign-link` | зовнішній лінк не на власний сайт/соцмережу бізнесу |
| `unknown-asset` | `<img src>` поза `/assets/` і `/generated/`, або файл не зі snapshot |
| `ai-photo-as-real` | AI-картинка з alt, що називає бізнес |
| `missing-noindex` | немає `<meta name="robots" content="noindex">` |
| `no-verified-contact` | жодного контакту зі snapshot на сторінці |

Ціни й роки навмисно не плутаються з телефонами (перевірено тестом).
Прозові твердження ("award-winning") — робота візуального критика: регекс їх не
судить, і вдавати протилежне означало б хибну впевненість.

## 5. Stage 11 — visual QA (`visualQa.ts`)

**Детерміновано** (Playwright, без моделі), 390/768/1440:

- горизонтальний overflow (з переліком винних елементів);
- console errors, uncaught page errors, failed requests;
- биті картинки (`naturalWidth === 0`);
- **розтягнуті** картинки (intrinsic vs rendered ratio, з поправкою на `object-fit`);
- контакт зі snapshot реально видно на сторінці;
- noindex у відрендереному HTML;
- назва бізнесу присутня;
- **reduced-motion прогін**: жоден текстовий елемент не лишається на `opacity: 0`
  (задокументована пастка з DESIGN.md).

**Критик** (мультимодально, `kind: visual-critique`, heavy): читає скриншоти як
файли, ставить 0-10 по чотирьох осях §2.4 (типографічна ієрархія, ритм відступів,
обробка фото, доцільність моушну) і видає issues з severity + конкретним `fix`.
Ban-list слоупу — частина промпта. Падіння критика не валить job (детерміновані
гейти лишаються), але й не пропускає сторінку автоматично.

Issues (детерміновані + критик ≥ `QA_FEEDBACK_SEVERITY`, дефолт medium) →
`QA-ISSUES.md` **у той самий workspace** → білдер фіксить на місці. Кожна ітерація
пише свій JSON-звіт; ключі накопичуються в `site_projects.qa_report_keys`.

## 6. Stage 12 — private deploy (`deploy.ts`)

`out/` копіюється в `deploys/<token>/`, де token — 24 символи з 36-символьного
алфавіту (~124 біти). Роздає демо-сервер з `X-Robots-Tag: noindex, nofollow,
noarchive, nosnippet`, без лістингу директорій; корінь `deploys/` віддає 404, тому
набір живих токенів не перебирається.

**Health check — справжній GET:** 200 + заголовок noindex + `<meta robots noindex>`
у HTML + назва бізнесу в тілі. Не пройшло — job падає, URL не записується.

Ідемпотентність: повторний deploy того ж проєкту перевикористовує `deploy_token`,
тому вже надіслана Роману картка approval не ламається.

Публічний домен клієнта тут не створюється ніколи.

**Два сервери на `DEMO_PORT`:** фаза D роздає `deploys/` з `src/api/server.ts`
(hono). Мій `ensureDemoServer()` ковтає `EADDRINUSE` — якщо API вже тримає порт,
health check б'є по ньому. Конфлікту немає в обидва боки.

## 7. Медіа (§2.5)

```text
Завантажений wow-кліп → ffmpeg Ken Burns MP4 з РЕАЛЬНОГО фото → CSS/GSAP Ken Burns
```

Останній рівень не потребує нічого зовнішнього, тому пайплайн проходить end-to-end
на будь-якій машині. Плюс опційно **один** декоративний фон через `gen-image`
(`MEDIA_GEN_IMAGES=false` вимикає). Обидва шляхи логують помилку і деградують —
декор не є доказом, його відсутність не блокує білд.

Усе згенероване йде через `registerGeneratedAsset()` → `ai_generated=true` +
`rights='private_demo_only'` (прапорці зашиті, не параметри).

## 8. Схема БД

`drizzle/0003_site_projects_phase_c.sql` додає в `site_projects`:
`snapshot_key`, `design_score`, `build_seconds`, `qa_report_keys` (jsonb),
`open_issues` (jsonb), `deploy_token`, індекс по `business_id`.

`state`: `pending → brief → building → qa → ready → deployed`, або `needs_human_review`.

## 9. Env

| Змінна | Дефолт | Що це |
|---|---|---|
| `BUILDER_MODE` | tmux | `tmux` — до збірки можна підключитись; `sdk` — безголова сесія. Без tmux на хості → автоматично `sdk` |
| `BUILD_TERMINAL_WEB` | true | піднімати ttyd на час збірки |
| `BUILD_TERMINAL_BASE_URL` | — | куди веде кнопка «Відкрити термінал». Порожньо = кнопки немає, тільки SSH |
| `BUILD_TERMINAL_PORT` | 7681 | порт ttyd усередині `agent-runner-executor` |
| `BUILD_TERMINAL_WRITABLE` | false | дозволити друкувати живому агенту (див. застереження вище) |
| `BUILDER_MAX_TURNS` | 200 | стеля ходів свіжого білда |
| `BUILDER_FIX_MAX_TURNS` | 120 | стеля ходів QA-фікса |
| `BUILDER_TIMEOUT_MINUTES` | 90 | wall-clock однієї сесії |
| `BUILD_VERIFY_TIMEOUT_MINUTES` | 20 | незалежний `pnpm build` |
| `QA_FEEDBACK_SEVERITY` | medium | від якої severity issues критика йдуть назад |
| `MEDIA_GEN_IMAGES` | true | генерувати декоративний фон |
| `MAX_QA_ITERATIONS` | 3 | стеля циклу |
| `DEPLOYS_DIR` | deploys | куди кладуться демо |
| `DEMO_HOST` | 127.0.0.1 | бінд демо-сервера (назовні — тільки через тунель, §8) |

Бюджет агентів на демо — без ліміту (рішення №5); ходи обмежені тільки щоб
відловити зациклений агент, а не щоб заощадити.

## 10. Перевірка

```bash
pnpm phasec:unit                       # 30 перевірок: рубрика + provenance, без мережі
pnpm phasec:fonts                      # звірка грекостійких шрифтів з маніфестом Next
pnpm phasec:deploy-check               # traversal, лістинг, noindex, health check
pnpm phasec:workspace <bizId>          # workspace без жодного агента
pnpm phasec:qa <outDir> <bizId> --shots <dir>   # детерміновані гейти на готовому export
pnpm phasec:critic-check <shotsDir> "<name>"    # тільки мультимодальний критик
pnpm phasec:fixture --seed             # лише seed fixture evidence
docker compose exec factory pnpm tsx scripts/phaseC-fixture.ts --run
                                          # F1 через central enqueue + живі workers/runner
pnpm phasec:run <bizId> --all          # реальний прогін 9→12
pnpm phasec:run <bizId> --stage 11     # тільки QA поточного export (без ребілду)
pnpm phasec:fixture --clean            # прибрати фікстуру
pnpm test:tmux-agent                   # гард-паритет, ttyd argv, маркери — без tmux і без мережі
pnpm test:tmux-agent --live            # + одна СПРАВЖНЯ сесія claude у tmux (потрібен tmux і підписка)
```

## 11. Logical run і physical attempts

Stage 9–12 не викликаються acceptance-скриптом вручну. F1 створює один
`content-and-design` command через центральний `enqueue`; далі production
workers володіють усіма successor stages. Один `workflow_job_runs` рядок — це
логічна команда, а `workflow_jobs` — append-only attempts. Rate-limit не
перезапускає старий ledger row: він додає successor attempt під тим самим run.
Concurrent duplicate command пригнічується active unique index, а count/time
видно у System UI.

Це прибирає колишню acceptance race, коли прямий виклик handler-а одночасно
enqueue-ив successor, якого міг claim-нути живий worker у тому самому
workspace.

## 12. Операційні властивості

**Групи воркерів — ВИРІШЕНО і реалізовано.** `AGENT_CONCURRENCY` + `withAgentSlot`
— FIFO-черга **в межах процесу**. Коли один процес хостить усі типи jobs,
40-хвилинна сесія `build-site` і бек-лог `enrich` голодують один одного
(спостережено: 126 jobs у черзі, білд не стартував 50 хв).

`src/workers/main.ts` тепер реєструє jobs **групами**:

| Група | Jobs | Характер навантаження |
|---|---|---|
| `core` | discover, normalize, fast-qualify, collect-assets, audit-website, readiness-gate, deploy-demo, request-approval, send-outreach, send-followup, poll-replies, daily-summary | детермінований + розклади |
| `enrich` | enrich, score-and-qa | багато середніх агентних викликів |
| `build` | content-and-design, build-site, visual-qa | кілька дуже довгих сесій |

```bash
pnpm workers                      # усі групи (локальна розробка, дефолт)
pnpm workers --only=core,enrich   # контейнер factory
pnpm workers --only=build         # контейнер factory-build
WORKER_GROUPS=build pnpm workers  # те саме через env (docker-compose)
```

Factory передає worker-group і актуальний ліміт у версіонованому runner-протоколі;
executor відновлює окремі семафори `core` / `enrich` / `build`, тому централізація
CLI не повертає одну спільну FIFO-чергу.
Розклади (`poll-replies`, `daily-summary`) реєструє тільки `core`, щоб два
процеси не дублювали їх. У `docker-compose` це два сервіси з одного образу:
`factory` (core+enrich, плюс API і демо-сервер) і `factory-build` (build,
`command: pnpm workers`). Обидва монтують спільні `sites/` і `deploys/`, але не
provider credentials: workspace копіює trusted gateway, CLI запускає executor.

Перемикання `AGENT_RUNTIME=codex` у UI кладе всі агентні етапи, включно з
білдом, на підписку ChatGPT. Прихованих per-stage runtime override немає: UI є
джерелом істини.

`scripts/phaseC-run.ts` попереджає, якщо для бізнесу вже є queued/running jobs.

**Скриншоти повного сторінки і scroll-reveal.** `fullPage: true` захоплює секції,
чиї scroll-reveal ще не спрацювали, якщо просто стрибнути вниз. `settlePage()`
проходить сторінку по вьюпорту, інакше критик бачить порожні смуги і пише
неіснуючі issues (реально спостережено до фіксу).

**Workspace GC — ВИРІШЕНО і реалізовано.** Зібраний workspace — ~735 МБ, майже
все `node_modules`. Після термінального стану (`deployed`, або
`needs_human_review`) `collectWorkspaceGarbage()` видаляє `node_modules`,
`.next`, `out` і `references`, лишаючи джерела, `input/`, `BUILD-TASK.md`,
`QA-ISSUES.md` і `result.json`. Виміряно на реальному бізнесі: **735 МБ → 9.0 МБ**.
Деплой уже лежить у `deploys/<token>/`, звіти — в object storage, тому нічого не
втрачається; `pnpm install` у тій теці відновлює збірний workspace.
Вимикається `WORKSPACE_GC=false`. Ніколи не валить деплой, який уже вдався.

**Абсолютні шляхи Next-export vs приватний URL під токеном (знайдено на
реальному деплої, виправлено).** Статичний експорт Next жорстко прописує
`/_next/static/...` (і `/assets/`, `/generated/`) з **провідним слешем**. Демо
роздається з `/<token>/`, тому браузер просить `/_next/...` у корені `deploys/`,
де нічого немає: сторінка віддає **HTTP 200 і рендериться повністю без стилів**,
з 404 на кожному шрифті, чанку і фото. Health check по статус-коду цього не
бачить — знайшлося тільки тому, що я подивився на скриншот задеплоєної сторінки.

Переписування експортованих файлів не рятує: клієнтський рантайм Next будує URL
чанків із внутрішнього `assetPrefix` під час виконання. Тому це виправлено в
`serveDir.ts`: абсолютний asset-запит перерозв'язується під тим демо, чия
сторінка його зробила (токен береться з `Referer`). Без реферера — 404, а не
здогад: здогад підсунув би фото одного бізнесу в демо іншого. Через це
`referrer-policy` — `no-referrer-when-downgrade`, а не `no-referrer`.

Health check тепер **окремо тягне stylesheet із задеплоєного URL** і вимагає
≥500 байт, тому цей клас багів більше не може пройти мовчки.

**Provenance судить контакти й медіа, не прозу.** "Award-winning" без доказу —
робота візуального критика і `forbiddenClaims` брифу, не регекса.

**`result.json` — це самозвіт, а не результат.** Спостережено реально: агент
завершив сесію успішно за 36 ходів, написав коректний сайт (`out/index.html`,
компоненти, `lib/site-data.ts`) і просто **не написав `result.json`** — і пайплайн
викинув перевірено-робочий білд у `NEEDS_HUMAN`. Тепер відсутній/невалідний
`result.json` при наявному `out/index.html` деградує до синтезованого звіту з
позначкою в `unresolved`, а гейтом лишається те, що й має бути гейтом:
незалежний `pnpm build` + provenance. Промпт додатково закінчується явним
"FINAL STEP, do not skip it".

**`verified` ≠ придатний до показу.** Реальні дані Patras містять
`https://instagram.com/_u` з `verified=true` — артефакт скрейпінгу, який на демо
став би битим лінком перед власником бізнесу. `unusableContactReason()` у
`snapshot.ts` викидає структурно зламані контакти (зарезервовані домени
`example/test/invalid`, no-reply, телефони <8 цифр, платформенні шляхи
Instagram, редиректор Google). Фільтр навмисно консервативний: помилково
викинути справжній контакт гірше, ніж показати дивний.

---

## 12. Вау-рубрика і моушн-референси

Роман подивився перше демо і відхилив його як «дефолтна слоупочна залупа».
Провенанс, контакти, noindex, reduced-motion — усе було чисте; проблема суто
візуальна: **сторінка не рухалась**. Відповідь — пак моушн-референсів
(`references/motion/`, 17 нагороджених сайтів, знятих як scroll-through відео) і
шість вау-осей, які тепер проходять наскрізно через stage 9 і stage 11.

### Одна рубрика, два вимірювання

`src/build/motionRefs.ts` — єдине джерело осей (`WOW_AXES`), порогів і гейту
(`wowVerdict()`, текст — `renderWowGate()`). Схема, всі чотири промпти і код-гейт
будуються з одного масиву, тому розійтись не можуть.

**Гейт — три умови, всі мають виконатись:**

1. разом ≥ **9/18** (поріг із пропозиції пака);
2. **амбіція ≥ 10/15** по п'яти осях без `performanceReducedMotion`;
3. `heroMotion` > 0.

Друга умова з'явилась не з теорії, а з виміру. Прогнали критика по вже
задеплоєному демо Pagoulatos — тому самому, яке Роман відхилив — з підкладеним
референсом і моушн-кадрами. Результат: `heroMotion 2, scrollChoreography 1,
typeAsDesign 2, photoTreatment 1, microInteraction 1, performanceReducedMotion 3`
= **10/18, тобто вище порогу 9**. Сторінка, яку Роман забракував, пройшла б по
сумі. Витягує її саме гігієнічна вісь: там, де нічого не анімується, нічого й не
ламається під reduced motion, і вона безкоштовно дає 3/3. Тому амбіція рахується
окремо — Pagoulatos дає 7/15 і коректно падає. Це зафіксовано регресійним тестом
у `scripts/phaseC-unit.ts` із реальними числами того прогону.

| Вісь | 3 бали |
|---|---|
| `heroMotion` | перший екран рухається сам, і рух прив'язаний до контенту |
| `scrollChoreography` | є pinned/scrub-послідовність, де скрол **керує** анімацією |
| `typeAsDesign` | display-тип >8vw, контраст ~10:1, обрізаний вордмарк або roman/italic |
| `photoTreatment` | один грейд на всі фото; full-bleed або маска; кропи обрані, не прийняті |
| `microInteraction` | hover, що масштабує/розкриває всередині кропу; продуманий курсор |
| `performanceReducedMotion` | плавно; нічого не лишається на `opacity: 0`; лупи реально вимкнені |

**Stage 9** оцінює вау як *обіцянку* написаного напрямку; **stage 11** — як
*факт* по зібраній сторінці. Обидві оцінки лежать у `site_projects.wow_scores`
(`{design, qa}`, міграція `0009_wow_scores.sql`) — розрив між ними і є цікавим
числом: напрямок може обіцяти scroll-linked герой, а білдер здати статичний.

### Stage 9: референс став обов'язковим полем контракту

`ArtDirectionSchema` отримала `referenceSlug` (рівно один slug з індексу пака),
`mechanics[]` (3-4 механіки з `{name, component, where}`), `heroMotion`
(`video|kenburns|mask|split|none`), `preloader`, `typeAsDesign`, `photoGrade`.

Арт-директор бачить **повний індекс** (17 рядків, ~3.3KB) і **зжаті notes**
5 найближчих за категорією референсів (~22KB на п'ятьох). `condenseNotes()`
лишає тільки «What makes the wow» + «Reproduce with our stack» + «Don't borrow»,
викидаючи timing/palette/mobile-прозу: 7-15KB → 4-6KB на файл. Відео не
відправляється взагалі — агент не може його подивитись, notes для того й є.
Ніша-пак ужато з 24KB до 14KB, щоб звільнити місце.

Нові вето (`vetoesFor`): неіснуючий slug, `heroMotion: none` без обґрунтування,
`video` без відео-ассета, `kenburns/mask/split` без жодного справжнього фото.
`wow` увійшла у ваги як повноцінна вісь (0.22, нарівні з distinctiveness), плюс
окремий `WOW_GATE_PENALTY = 2.5` за провалений поріг — тому напрямок зі
статичним героєм програє рухомому навіть коли критик оцінив його вище за смаком.

### Stage 11: критик бачить рух і бачить планку

1. **Моушн-докази.** `captureMotionEvidence()` знімає 11 кадрів: viewport на
   0.15/0.8/1.6/2.4/3.6s після завантаження і на 0/20/40/60/80/100% скролу.
2. **Детермінований вердикт про героя** — без моделі, двома вікнами:
   - *вхід* (0.15s→1.6s, поріг 1.5% пікселів) — чи взагалі щось сталося;
   - *утримання* (2.4s→3.6s, поріг 0.4%) — чи герой **продовжує** рухатись після
     того, як усі entrance-анімації завершились.
   Потрібні **обидва**. Блок, що один раз проявився і завмер, — це статичний
   герой у костюмі, і саме його ловить друге вікно. Порівняння пікселів іде
   через `new Function` (див. коментар у коді: tsx/esbuild інжектить `__name` у
   іменовані внутрішні функції, і `page.evaluate` тягне їх у браузер).
3. **Референс поруч зі скриншотами.** `hero.jpg` і `full.jpg` обраного slug
   підкладаються критику з явною позначкою «це НЕ наша сторінка, це планка», і
   він заповнює `referenceComparison {slug, closeness 0-10, gap}`.
4. **Гейт застосовує код, не критик.** Якщо браузер виміряв героя статичним,
   `wow.heroMotion` примусово стає 0 незалежно від щедрості критика; далі
   `wowVerdict()`: <9/18 або heroMotion 0 → high-severity issue категорії `wow`
   з текстом «дефолтний AI-шаблон» і конкретним фіксом.

Детерміновані гейти: overflow, console/pageerror, failed requests,
розтягнуті й биті картинки, `clippedText`, placeholders, контакти,
noindex, reduced-motion invisible, щільність контенту, співвідношення
висоти до копірайту та частка площі реальних evidence-фото. Ліміт ітерацій
той самий.

### Workspace

`prepareWorkspace()` більше **не** копіює весь `references/motion/` (60MB,
переважно відео) — тільки `notes.md` + `hero.jpg` + `full.jpg` обраного
референсу в `<workspace>/references/<slug>/`. BUILD-TASK.md отримав розділ
«Motion»: шість осей із порогом, список 3-4 механік із точними компонентами,
правило героя, кап прелоадера 1.2s, фото-грейд, бюджет продуктивності, вимогу
reduced-motion, правило EB_Garamond для грецького italic і два нові пункти
Definition of done («герой рухається», «всі механіки реально анімуються»).

### Production thresholds

- `inkPer1000px >= 14` на desktop; додатково сторінка вища за 4500px з
  щонайменше 800 символами не може перевищувати 4px висоти на символ.
- Якщо evidence package має реальні фото, вони мають займати щонайменше 8%
  desktop-page area. Враховуються лише URL реальних snapshot assets, а не SVG,
  згенеровані фони чи іконки.
- Кожна з 3-4 механік контракту отримує `implemented | partial | absent` verdict з
  посиланням на motion-frame. `absent` блокує як high, `partial` — як medium;
  без повного виконання всього scene map QA не проходить.
- Числові пороги живуть у `src/build/layoutQuality.ts` та мають швидкий
  regression у `scripts/test-layout-quality.ts`; QA report зберігає сирі метрики.
- Дробові оцінки критика округлюються схемою. Це не послаблює гейти і не
  спалює цілий agent retry через відповідь на кшталт `5.5`.
