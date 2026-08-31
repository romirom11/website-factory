# Websites Factory — end-to-end flow

**Статус:** навігаційний опис реалізованої системи. Авторитетні правила та
бізнес-рішення — `docs/SPEC.md`; production rollout —
`docs/PRODUCTION-ROLLOUT.md`.

Стара v1 цього документа описувала n8n + Redis і Telegram approvals. Вона
лишилась у git history, але не є варіантом deployment: поточна фабрика —
TypeScript + PostgreSQL/pg-boss + Web UI, а Telegram тільки сповіщає.

## Control flow

```text
campaign command / schedule
  ↓
discovery (gosom REST)
  ↓ immutable raw evidence
normalize + deterministic dedup
  ↓
fast qualification
  ↓
enrich agent (structured, evidence-only)
  ├─ collect-assets ─┐
  └─ website-audit ──┴─ enrichment_runs barrier
                         ↓ only after both branches succeed
score + independent QA
  ↓
production-readiness gate
  ↓
content brief + 3 art directions + deterministic rubric
  ↓
builder agent in exact workspace
  ↺ Playwright/provenance/visual QA, bounded iterations
  ↓
private tokenized deploy + noindex
  ↓
Telegram link → approval card in Web UI
  ↓ recorded DB approval only
outreach (campaign dry-run/live gate + exactly-once key)
  ↓
follow-ups / replies / deal states
```

LLM outputs never transition business state, select the winning art direction,
authorize a send, claim queue ownership or decide retries. Those are typed code,
transactions and compare-and-swap updates in Postgres.

## Multi-agent boundary

Workers call one `AgentRuntime` interface for structured extraction and
workspace coding. Production requests cross this boundary:

```text
factory worker
  → authenticated agent-runner-gateway (staging/sync, no provider auth)
  → private agent-runner-executor (provider CLI + exact workspace)
  → filtered DNS + egress proxy
```

The executor has no default Compose network, factory secrets, Postgres/MinIO
route, Docker socket or host mounts. Claude and Codex use fail-closed native
sandboxes; OpenCode tool subprocesses are not sufficiently confinable, so its
production `codeAgent()` is rejected and routed to `needs_human`. Output is
secret-scanned before sync.

## Job lifecycle

One operator command is one row in `workflow_job_runs`. Its physical pg-boss
deliveries are append-only rows in `workflow_jobs`:

```text
logical run: queued → running → succeeded | failed | needs_human | cancelled
                          ↘ retry_wait → successor attempt → running

attempt #1 ─ terminal
attempt #2 ─ terminal
attempt #3 ─ current
```

An active unique index on `(job_type, idempotency_key)` suppresses concurrent
duplicate commands. Suppression count/time is persisted on the canonical run
and visible in `/settings/system`; a duplicate never creates a second pg-boss
delivery. Rate-limit continuation appends a successor attempt under the same
run. Old terminal rows with nullable `run_id` remain readable during the
additive rollout.

Worker capacity is split by group (`core`, `enrich`, `build`).
`WorkerConsumerPool` owns one pg-boss handle per configured consumer with
`batchSize: 1`; the runner independently restores per-group agent semaphores.
A long build therefore does not consume the enrichment group’s capacity.

## Enrichment fan-in

`enrichment_runs` is the durable join for `collect-assets` and
`audit-website`. Each generation records both branch states. Only the barrier
can enqueue `score-and-qa`, and only once. A failed/stale branch blocks the run
with a readable reason; it cannot score partial evidence. Re-enrichment
supersedes the older generation instead of racing it.

## Business and outreach safety

- Every verified fact/contact points to `business_sources` and immutable raw
  storage; missing evidence becomes `null`/gap.
- Status transitions are allowlisted CAS commands with append-only history.
- Readiness gaps block site production; an agent cannot waive them.
- A send requires a recorded approved `approvals` row for that business.
- Live delivery requires **both** global factory mode and campaign mode to be
  `live`; either `dry_run` forces adapter simulation.
- Send idempotency derives from approval ID and is unique in the DB. Send jobs
  have no automatic retry.
- DNC, daily limit, reply/bounce/opt-out and deal state are checked again at
  execution time.
- Instagram/Viber remain manual deep-link channels. Telegram never performs
  control actions.

## Operator view

The control surface is Next.js UI on `:3000`:

- `/inbox`: approvals, build decisions, replies and actionable failures;
- `/businesses`: funnel and business evidence;
- `/campaigns`: campaign policy and progress;
- `/settings/accounts`: provider and channel bootstrap;
- `/settings/system`: service/runner health, worker heartbeats/capacity,
  logical runs with attempts, duplicate suppression, retry pauses and blocked
  enrichment barriers.

Structured logs carry `campaignId`, `businessId`, `runId`/`jobId` where
available. Telegram emits notifications with UI links; it is not a second
control plane.

## Acceptance

`pnpm release:gate` is the release decision. It includes static builds,
deterministic regressions, disposable-Postgres job/migration tests, Compose
readiness, runner confinement, fixture-only smoke/browser/integration flows and
a real F1 multi-agent site generation through the central queue. Automated
mutations are rejected unless every entity id starts with `e2e-`.
