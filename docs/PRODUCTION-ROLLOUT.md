# Production rollout і recovery

Це операційний runbook для змін у job lifecycle, enrichment barrier та
ізольованому agent runner. Архітектурне джерело істини — `docs/SPEC.md`;
виконуваний release-контракт — `pnpm release:gate`.

## Незворотний safety baseline

Production agent calls завжди йдуть через `agent-runner-gateway` →
`agent-runner-executor`. Executor не має factory secrets, default network,
Docker socket чи host bind mounts. Rollback **ніколи** не означає повернення
`AGENT_EXECUTION_MODE=local-development`, монтування provider credentials у
factory або послаблення runner sandbox. Якщо canary не проходить — jobs
лишаються на паузі, а виправлення котиться вперед.

## Перед початком

1. Переконайся, що `.env` містить окремі `RUNNER_API_KEY` і
   `RUNNER_EXECUTOR_API_KEY`, `UI_PASSWORD`, `UI_SESSION_SECRET`,
   `SETTINGS_MASTER_KEY`; provider credentials тут не зберігаються. Якщо
   агентні етапи йдуть через OpenCode — `OPENCODE_PROVIDERS` перелічує id
   провайдерів, яким відкрито egress (ключі підключаються в UI).
2. Зроби backup БД і перевір, що dump читається:

   ```bash
   mkdir -p backups
   docker compose exec -T postgres pg_dump -U factory -Fc factory > backups/factory-before-runner.dump
   pg_restore --list backups/factory-before-runner.dump >/dev/null
   ```

3. Зафіксуй поточні volumes `miniodata`, `sitesdata`, `deploysdata` засобами
   хоста. Окремо збережи `.env`: без `SETTINGS_MASTER_KEY` DB-secrets не
   відновити.
4. Запусти швидкий, але **не release-достатній** цикл:

   ```bash
   pnpm release:gate -- --quick
   ```

## Безпечна послідовність deploy

### AppArmor-профіль executor-а: завантажується автоматично

`agent-runner-executor` закріплений у compose за профілем `wf-runner-executor`
(`deploy/apparmor/wf-runner-executor`: docker-default із дозволом
`userns`/`mount`/`pivot_root` — тільки те, що потрібно вкладеному bubblewrap).
Під `docker-default` або `unconfined` readiness падає на `bwrap: Failed to make /
slave: Permission denied` / `setting up uid map: Permission denied`, бо Ubuntu
24.04 переводить unconfined-процес при створенні userns у профіль
`unprivileged_userns` без capabilities.

Профіль у ядро хоста завантажує сервіс `agent-runner-apparmor` (privileged,
образ = `apparmor_parser` + профіль + `load.sh`, після завантаження лише idle і
перевіряє профіль раз на хвилину). Executor має `depends_on ... service_healthy`
на нього, тому стартує тільки з уже завантаженим профілем — при кожному deploy і
після перезавантаження хоста, без дій оператора. На хості без AppArmor loader
стає healthy зі «skip». `kernel.apparmor_restrict_unprivileged_userns` чіпати
не треба. Перевірка: `docker compose logs agent-runner-apparmor` →
`ok: AppArmor profile wf-runner-executor loaded into the host kernel`.

### Dokploy: вимкнути Isolated Deployment (одноразово)

У Compose → Advanced вимкни deprecated **Isolated Deployment**. У цьому режимі
Dokploy створює звичайну bridge-мережу `<appName>` (з gateway, тобто з прямим
виходом в інтернет) і додає її до **кожного** сервісу, навіть якщо вихідний
compose явно залишив executor лише у двох internal-мережах. Без цього режиму
Dokploy додає `dokploy-network` лише сервісам, на які налаштовано домени (ui,
factory, factory-build), і саме так Traefik до них дістається; executor
залишається рівно з тими мережами, що в compose. Назви volume-ів не змінюються
(`<appName>_pgdata` тощо — це стандартний префікс проєкту, а не Isolated
Deployment), тож дані не втрачаються.

Після наступного deploy відкрий Converted Compose та перевір, що executor має рівно:

```yaml
networks:
  - runner-control
  - runner-egress-v2
```

`dokploy-network`, `<app-name>-<suffix>`, `default` або інша external network у
цьому списку є помилкою конфігурації. Executor тепер також перевіряє kernel route
table на startup, в `/health` і перед кожним authenticated control request; за
наявності default route він навмисно лишається unhealthy та не приймає нову
агентну роботу з прямим виходом у мережу.

### 1. Поставити jobs на maintenance pause

Не змінюй статуси jobs вручну й не видаляй pg-boss rows. Зупини обидва процеси,
які можуть claim-ити роботу:

```bash
docker compose stop factory factory-build
```

Postgres, MinIO та UI можуть лишатися доступними для читання. Factory API на
час maintenance буде down — System UI покаже це чесно.

### 2. Підняти runner canary першим

```bash
docker compose build agent-runner-gateway agent-runner-executor agent-egress-proxy agent-egress-dns
docker compose up -d --wait agent-egress-dns agent-egress-proxy agent-runner-executor agent-runner-gateway
pnpm test:runner-isolation
```

Gate має довести approved package egress, deny довільного CONNECT/DNS/raw IP,
відсутність route до factory/Postgres/MinIO/host, невидимість provider
credentials для gateway, exact-workspace isolation, падіння readiness після
зупинки proxy та OpenCode-шлях (connect → sandboxed run через broker →
NEEDS_HUMAN на відхиленому ключі). Allowlist живе в одному реєстрі
`infra/agent-egress/`: inherent-домени в `runtime-domains.txt`, провайдери
OpenCode — у згенерованому `opencode-providers.tsv` (`pnpm egress:catalog`),
увімкнені через `OPENCODE_PROVIDERS`. Squid і CoreDNS рендерять свої списки з
нього при старті, Claude tool-sandbox і broker читають його ж у runtime.

Після будь-якої зміни реєстру чи `OPENCODE_PROVIDERS` повтори весь isolation gate.

`RUNNER_DNS_PROTECTION_ENABLED=true` є production default. Значення `false`
дозволяє unrestricted **public DNS** для аварійної діагностики або сумісності,
але не змінює internal-only runner topology, HTTP(S) allowlist чи блокування
Compose service names. Після зміни прапорця також повтори
`pnpm test:runner-isolation`.

### 3. Застосувати тільки адитивну схему

```bash
pnpm db:migrate
```

`workflow_jobs.run_id` і `attempt_sequence` лишаються nullable: завершені
legacy rows читаються без backfill. Нові поля duplicate-observability мають
default і не блокують старі writers. `enrichment_runs` додає ledger fan-in,
але не переписує evidence.

Перевір:

```sql
select column_name, is_nullable
from information_schema.columns
where table_name = 'workflow_jobs'
  and column_name in ('run_id', 'attempt_sequence');
```

Обидві колонки мають бути `YES`.

### 4. Reconcile legacy active work до запуску handlers

Startup path бере advisory lock і виконує reconciliation перед реєстрацією
consumers. Спершу програй ту саму поведінку на disposable Postgres:

```bash
pnpm tsx scripts/test-reconcile.ts
pnpm tsx scripts/test-job-idempotency.ts
pnpm tsx scripts/test-rate-limit-requeue.ts
```

Потім запусти лише core service й прочитай структурований звіт:

```bash
docker compose up -d factory
docker compose logs --since=5m factory | rg 'startup reconciliation|legacy_run_adopted|RECONCILIATION_REQUIRED'
```

Операторський SQL-звіт:

```sql
select event_type, count(*)
from workflow_reconciliation_events
group by event_type
order by event_type;

select job_type, status, count(*)
from workflow_jobs
where run_id is null
  and status in ('queued', 'running', 'retry_wait')
group by job_type, status
order by job_type, status;
```

Другий restart/reconciliation має додати **0** нових repair events. Невідомі
queue mappings та кілька одночасно active deliveries не вгадуються: вони
паркуються в `needs_human` з `RECONCILIATION_REQUIRED`.

### 5. Запустити build workers і дренувати compatibility path

```bash
docker compose up -d --wait factory-build ui
```

Стеж за `/settings/system`: logical run групує всі physical attempts,
`retry_wait` показує час відновлення, duplicate suppression — кількість
поглинутих команд, blocked enrichment — конкретний бізнес і причина. Legacy
attempts без `run_id` лишаються видимими як `legacy ledger`.

Compatibility path вважається дренованим лише коли цей запит повертає 0:

```sql
select count(*)
from workflow_jobs
where run_id is null
  and status in ('queued', 'running', 'retry_wait');
```

Terminal legacy rows не треба насильно backfill-ити або видаляти.

### 6. Повний release gate

```bash
pnpm release:gate
```

Він будує всі production images, чекає Compose readiness, запускає security
boundary, disposable-DB lifecycle/migration rehearsal, fixture-only smoke,
browser E2E, real gosom integration і F1 multi-agent generation через
центральний enqueue. Звіт пишеться в `.artifacts/release-gate/latest.json`.
Green status у чаті чи ручний smoke не заміняє цей файл.

## Account bootstrap

1. `/settings/accounts` → Claude Code → `Підключити`; account flow пише token
   `0600` тільки в `runnerclaude` volume і робить реальний check.
2. `/settings/accounts` → Codex → `Підключити`; browser/device login зберігає
   credential тільки в `codexhome`.
3. `/settings/accounts` → OpenCode → провайдер + API-ключ → `Підключити`;
   ключ лягає в `auth.json` тільки в `opencodehome` і перевіряється реальним
   викликом. Провайдер має бути в `OPENCODE_PROVIDERS`; у production збірки
   йдуть усередині Codex-пісочниці через credential broker executor-а.
4. Telegram перевіряється кнопкою в UI. Він лише сповіщає і лінкує в UI —
   жодних approval/command handlers у боті немає.

## Roll-forward recovery

Якщо після cutover зростають `failed`, `RECONCILIATION_REQUIRED`, blocked
barriers або runner стає `degraded`:

1. `docker compose stop factory factory-build` — припини нові claims.
2. Не видаляй `workflow_jobs`, `workflow_job_runs`, `enrichment_runs` або
   `pgboss.job`: це діагностичний ledger і основа безпечного продовження.
3. Збери `docker compose logs --since=30m factory factory-build agent-runner-gateway agent-runner-executor agent-egress-proxy`.
4. Виправ причину, перебудуй тільки потрібні images, повтори security та
   lifecycle gates.
5. Підніми `factory`, дочекайся reconciliation report; потім
   `factory-build`.

Відкат image дозволений лише якщо він також використовує remote runner і
розуміє адитивну схему. Фізичне видалення нових колонок/таблиць у цьому rollout
не виконується.
