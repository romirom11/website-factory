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
   `SETTINGS_MASTER_KEY`; provider credentials тут не зберігаються.
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

### Хост: AppArmor-профіль executor-а (одноразово, на кожному Linux-хості)

`agent-runner-executor` закріплений у compose за профілем `wf-runner-executor`.
Без нього на хості з AppArmor контейнер не стартує взагалі (runc: profile not
found), а під `docker-default` або `unconfined` стартує, але readiness падає на
`bwrap: Failed to make / slave: Permission denied` / `setting up uid map:
Permission denied`. Тому перед першим deploy (і після кожної зміни файлу в
`deploy/apparmor/`) на хості:

```bash
cd /etc/dokploy/compose/<app>/code      # або будь-який checkout репо
sudo scripts/install-runner-apparmor.sh # idempotent; друкує "ok: ... loaded"
```

Скрипт ставить `deploy/apparmor/wf-runner-executor` у `/etc/apparmor.d/`,
завантажує його `apparmor_parser -r` і перевіряє, що профіль видно в
`/sys/kernel/security/apparmor/profiles`. Це docker-default із дозволом
`userns`/`mount`/`pivot_root` — тільки те, що потрібно вкладеному bubblewrap.
`kernel.apparmor_restrict_unprivileged_userns` чіпати не треба.

### Dokploy: не дозволяти платформі розширювати executor network

У Compose → Advanced вимкни deprecated **Isolated Deployment**. Цей режим
Dokploy додає свою зовнішню мережу до **кожного** сервісу, навіть якщо вихідний
compose явно залишив executor лише у двох internal-мережах.

Після цього у Compose → Networks для `agent-runner-executor` увімкни
**Detach dokploy-network** і redeploy. Gateway лишається на звичайній мережі для
зв'язку з factory, а proxy/DNS — для контрольованого public egress. Від
зовнішньої/default мережі від'єднується тільки executor.

Перед запуском jobs відкрий Converted Compose та перевір, що executor має рівно:

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
credentials для gateway, exact-workspace isolation та падіння readiness після
зупинки proxy. Розширення allowlist дозволене лише синхронною зміною:

- `infra/agent-proxy/squid.conf`;
- `infra/agent-dns/Corefile`;
- `APPROVED_TOOL_DOMAINS` у `src/agents/confinement.ts`, якщо домен потрібен
  tool subprocess.

Після будь-якої такої зміни повтори весь isolation gate.

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
3. OpenCode: `docker compose exec agent-runner-executor opencode auth login`.
   У production він дозволений для tool-free structured calls; builder/QA-fix
   fail-closed переходить у `needs_human`.
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
