/**
 * Factory-side HTTP surface. Two servers:
 *
 *  1. Internal API (dashboardPort): health + inbound webhooks (WhatsApp replies).
 *     The HTML dashboard that used to live here was removed in phase D — the
 *     Next.js control UI (`ui/`) is the interface now, and it reads Postgres
 *     directly instead of proxying through this process.
 *  2. Demo static server (demoPort): serves built demo sites with noindex.
 *     The UI's approval preview iframes DEMO_BASE_URL, which points here.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, pool, schema } from '../db/client.js';
import { ensureDemoServer, registerPreview, startDemoServer } from '../lib/serveDir.js';
import { writeQaIssues } from '../build/workspace.js';
import { buildLogPath, readBuildLog } from '../build/buildLog.js';
import { liveTerminal } from '../agents/tmuxRuntime.js';
import { TERMINAL_USER, terminalPassword } from '../agents/terminalServer.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { handleWahaWebhook } from '../outreach/wahaInbound.js';
import { verifyApiKey, verifyHmac } from '../outreach/wahaWebhook.js';
import { effectiveConfig, isCheckKind, runCheck } from './checks.js';
import { cacheCheckResult, collectChecks, invalidateCheck } from './checkCache.js';
import {
  activeSession, cancelSession, connectOpenCode, disconnect, isAccountProvider,
  isCliAccountProvider, openCodeAccountStatus, startSession, submitCode, telegramChats,
} from './accounts.js';
import type { AccountOperation, AccountProviderInput } from '../agents/transport.js';
import { reloadSettings } from '../lib/settingsStore.js';
import { writeSetting } from '../lib/settingsStore.js';
import { usesRemoteAgentTransport } from '../agents/transport.js';
import { remoteAgentTransport } from '../agents/remoteTransport.js';
import { ensureQueues, enqueue, getBoss } from '../orchestrator/queue.js';
import { createInternalAuth } from './internalAuth.js';
import { registerJobCommandRoute } from './jobCommands.js';
import { registerBusinessTransitionCommandRoute } from './businessTransitionCommands.js';
import { businessTransitions } from '../orchestrator/statuses.js';
import { registerBuildFailureCommandRoute } from './buildFailureCommands.js';
import { stopFailedBuild } from '../orchestrator/buildFailureDecision.js';
import { registerBuildReviewCommandRoute } from './buildReviewCommands.js';
import { registerOutreachDecisionCommandRoutes } from './outreachDecisionCommands.js';
import { OutreachDecisionService } from '../orchestrator/outreachDecisionService.js';
import { WorkflowRunStore } from '../orchestrator/workflowRunStore.js';
import { registerCampaignCommandRoutes } from './campaignCommands.js';
import { CampaignCommandService } from '../orchestrator/campaignCommandService.js';
import { registerOperatorBusinessCommandRoutes } from './operatorBusinessCommands.js';
import { OperatorBusinessCommandService } from '../orchestrator/operatorBusinessCommandService.js';

export async function startApi(): Promise<void> {
  // Queue creation is part of readiness. In API-only mode there may be no
  // worker process to prepare build/agent queues on our behalf.
  await ensureQueues();
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, mode: config.mode }));

  // ── Internal API for the control UI ────────────────────────────────────────
  //
  // The UI's /settings page asks the FACTORY to run connectivity checks, because
  // the factory is the process that will do the real sending and the only one
  // with the agent CLIs. Bound to 127.0.0.1 like everything else, but that is
  // network topology, not authentication — a shared secret is required so a
  // compromised sibling container cannot make the factory send Telegram
  // messages or dial SMTP on its behalf.
  //
  // Secret: INTERNAL_API_KEY, falling back to UI_SESSION_SECRET / UI_PASSWORD,
  // so a working setup needs no extra .env line. Empty secret = the endpoints
  // refuse everything rather than opening up.
  const internalAuth = createInternalAuth();
  const workflowRunStore = new WorkflowRunStore(pool, await getBoss());
  registerJobCommandRoute(app, internalAuth, enqueue);
  registerBusinessTransitionCommandRoute(
    app,
    internalAuth,
    (command) => businessTransitions.override(command),
  );
  registerBuildFailureCommandRoute(app, internalAuth, stopFailedBuild);
  registerBuildReviewCommandRoute(app, internalAuth);
  registerOutreachDecisionCommandRoutes(
    app,
    internalAuth,
    new OutreachDecisionService(
      workflowRunStore,
      db,
      () => config.followupDays,
    ),
  );
  registerCampaignCommandRoutes(
    app,
    internalAuth,
    new CampaignCommandService(workflowRunStore, () => config.mode),
  );
  registerOperatorBusinessCommandRoutes(
    app,
    internalAuth,
    new OperatorBusinessCommandService(workflowRunStore, db),
  );

  /**
   * Run one connectivity check and report the REAL result (never a throw).
   * `claude` costs a subscription call, `telegram` sends a real message —
   * both only ever on an explicit click in the settings page.
   */
  app.post('/internal/check/:kind', internalAuth, async (c) => {
    const kind = c.req.param('kind');
    if (!isCheckKind(kind)) return c.json({ ok: false, message: `unknown check: ${kind}` }, 400);
    const started = Date.now();
    // Force a snapshot reload FIRST. Roman clicks "Перевірити" seconds after
    // saving, well inside the 15s TTL, and a check that silently used the
    // previous value would report "token не заданий" about a token he just
    // pasted — the single most confusing thing this page could do.
    await reloadSettings().catch(() => { /* stale snapshot is still better than a 500 */ });
    const result = await runCheck(kind);
    log.info('settings check run', { kind, ok: result.ok, ms: Date.now() - started });
    // A manual click is the freshest possible answer, so it becomes the cached
    // one — otherwise the chip at the top of the card could keep showing a
    // ten-minute-old failure next to the green result of the click below it.
    await cacheCheckResult(kind, result);
    return c.json({ ...result, ms: Date.now() - started });
  });

  /**
   * Every check at once, from a 10-minute cache — what the settings page reads
   * on render so its status chips are REAL rather than inferred from "a row
   * exists in the settings table".
   *
   * Cached because `claude` is a real subscription call: without a cache, this
   * would put tens of seconds of dependency calls on every page load, and with
   * it a reload is free. `?refresh=<kind>` is one card's «Оновити» button and
   * re-runs exactly that check.
   */
  app.get('/internal/checks-cached', internalAuth, async (c) => {
    await reloadSettings().catch(() => {});
    const raw = c.req.query('refresh') ?? '';
    const refresh = isCheckKind(raw) ? raw : null;
    if (raw && !refresh) return c.json({ ok: false, message: `unknown check: ${raw}` }, 400);
    const started = Date.now();
    const checks = await collectChecks({ refresh });
    return c.json({ ok: true, checks, ms: Date.now() - started });
  });

  /**
   * What THIS process currently believes the configuration to be. Proves that a
   * value saved in the UI reached the running factory without a restart —
   * the whole point of moving settings into Postgres (Roman, 2026-08-17).
   */
  app.get('/internal/effective-config', internalAuth, async (c) => {
    // Same reasoning as the checks: this panel exists to prove propagation, so
    // it must never be the stale side of the TTL.
    await reloadSettings().catch(() => {});
    return c.json({ ok: true, config: effectiveConfig() });
  });

  // ── Connected accounts ─────────────────────────────────────────────────────
  //
  // Interactive logins driven from the console (`/settings` → «Підключені
  // акаунти»), so connecting Claude or Codex is a button and not a terminal
  // session on a second machine. The flows themselves live in `accounts.ts`;
  // these endpoints are the thin poll-based surface over them, because the
  // human step in the middle has no bounded duration.
  //
  // Same internal-key protection as the checks: these SPAWN processes and STORE
  // credentials, so they are strictly more sensitive than a read.

  async function remoteAccount(
    operation: AccountOperation,
    provider: 'claude' | 'codex' | 'opencode',
    code?: string,
    input?: AccountProviderInput,
  ) {
    try {
      return await remoteAgentTransport.account(operation, provider, code, input);
    } catch (error) {
      log.warn('remote account control failed', { operation, provider, error });
      return {
        ok: false,
        message: `Runner акаунтів недоступний: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      };
    }
  }

  /** Begin a flow. Returns the first snapshot; the UI then polls /status. */
  app.post('/internal/accounts/:provider/start', internalAuth, async (c) => {
    const p = c.req.param('provider');
    if (!isCliAccountProvider(p)) {
      return c.json({ ok: false, message: `${p}: немає інтерактивного логіну — OpenCode підключається ключем провайдера` }, 400);
    }
    if (usesRemoteAgentTransport()) return c.json(await remoteAccount('start', p));
    return c.json({ ok: true, session: startSession(p) });
  });

  /**
   * OpenCode: store one provider's API key (auth.json in the runtime owner's
   * volume) and prove it with a real call. The key never comes back.
   */
  app.post('/internal/accounts/opencode/connect', internalAuth, async (c) => {
    const body = await c.req.json().catch(() => null) as { providerId?: string; key?: string } | null;
    const providerId = String(body?.providerId ?? '').trim();
    const key = String(body?.key ?? '').trim();
    if (!providerId || !key) return c.json({ ok: false, message: 'Потрібні провайдер і ключ.' }, 400);
    const res = usesRemoteAgentTransport()
      ? await remoteAccount('connect', 'opencode', undefined, { providerId, secret: key })
      : { ok: true, session: await connectOpenCode(providerId, key) };
    await invalidateCheck('opencode');
    return c.json(res);
  });

  /**
   * Current phase. Poll target — the CLI output is parsed as it arrives, so the
   * URL appears here a moment after start, and `done` only after the credential
   * was stored AND re-verified with a real call.
   */
  app.get('/internal/accounts/:provider/status', internalAuth, async (c) => {
    const p = c.req.param('provider');
    if (!isAccountProvider(p)) return c.json({ ok: false, message: `невідомий провайдер: ${p}` }, 400);
    if (usesRemoteAgentTransport()) return c.json(await remoteAccount('status', p));
    if (p === 'opencode') return c.json({ ok: true, session: null, ...(await openCodeAccountStatus()) });
    return c.json({ ok: true, session: activeSession(p) });
  });

  /** Claude only: pipe the pasted code into the waiting CLI prompt. */
  app.post('/internal/accounts/:provider/submit-code', internalAuth, async (c) => {
    const p = c.req.param('provider');
    if (!isCliAccountProvider(p)) return c.json({ ok: false, message: `невідомий провайдер: ${p}` }, 400);
    const body = await c.req.json().catch(() => null) as { code?: string } | null;
    if (usesRemoteAgentTransport()) {
      return c.json(await remoteAccount('submit-code', p, String(body?.code ?? '')));
    }
    return c.json({ ok: true, session: submitCode(p, String(body?.code ?? '')) });
  });

  app.post('/internal/accounts/:provider/cancel', internalAuth, async (c) => {
    const p = c.req.param('provider');
    if (!isCliAccountProvider(p)) return c.json({ ok: false, message: `невідомий провайдер: ${p}` }, 400);
    if (usesRemoteAgentTransport()) return c.json(await remoteAccount('cancel', p));
    return c.json({ ok: true, session: cancelSession(p) });
  });

  /** "Відключити": ask the runtime owner to remove the provider credential. */
  app.post('/internal/accounts/:provider/disconnect', internalAuth, async (c) => {
    const p = c.req.param('provider');
    if (!isAccountProvider(p)) return c.json({ ok: false, message: `невідомий провайдер: ${p}` }, 400);
    // OpenCode holds one key per provider; the body names which one goes.
    const body = await c.req.json().catch(() => null) as { providerId?: string } | null;
    const providerId = p === 'opencode' ? String(body?.providerId ?? '').trim() : undefined;
    if (p === 'opencode' && !providerId) return c.json({ ok: false, message: 'Не вказано провайдера OpenCode.' }, 400);
    const res = usesRemoteAgentTransport()
      ? await remoteAccount('disconnect', p, undefined, providerId ? { providerId } : undefined)
      : await disconnect(p, providerId);
    if (usesRemoteAgentTransport() && p === 'claude' && res.ok) {
      await writeSetting('CLAUDE_CODE_OAUTH_TOKEN', '', 'runner-disconnect').catch(() => undefined);
      await reloadSettings().catch(() => undefined);
    }
    // The cached chip would otherwise keep saying «підключено» for up to ten
    // minutes about a credential that has just been deleted.
    if (isCheckKind(p)) await invalidateCheck(p);
    return c.json(res);
  });

  /**
   * Chats that have written to the Telegram bot, so the chat id is a click
   * rather than a number Roman has to dig out of a raw getUpdates response.
   * The token comes from the request when he has just typed it and not yet
   * saved it; otherwise the stored one is used.
   */
  app.post('/internal/accounts/telegram/chats', internalAuth, async (c) => {
    await reloadSettings().catch(() => {});
    const body = await c.req.json().catch(() => null) as { token?: string } | null;
    const token = (body?.token ?? '').trim() || config.telegram.botToken;
    return c.json(await telegramChats(token));
  });

  /**
   * Open a read-only preview of a build the critic rejected.
   *
   * A `needs_human_review` project never deployed, so there is no demo URL to
   * look at — and Roman cannot decide "ship it / one more pass / drop it"
   * without seeing the page. The workspace GC keeps `out/` for exactly this
   * state (`collectWorkspaceGarbage`), so the preview is a mount, not a rebuild:
   * the export is already on disk and is served by the demo server, which is the
   * only thing that re-roots a Next export's absolute asset paths correctly.
   *
   * Returns the URL rather than the files: the UI iframes it, same as it iframes
   * a deployed demo. When `out/` is genuinely gone (built before this GC rule),
   * it says so instead of serving a blank frame — a rebuild needs `pnpm install`
   * in the workspace and is a build job, not an HTTP request.
   */
  app.post('/internal/preview/:projectId', internalAuth, async (c) => {
    const projectId = Number(c.req.param('projectId'));
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return c.json({ ok: false, message: 'invalid project id' }, 400);
    }
    const [project] = await db.select().from(schema.siteProjects)
      .where(eq(schema.siteProjects.id, projectId));
    if (!project) return c.json({ ok: false, message: 'проєкт не знайдено' }, 404);

    const out = path.join(project.dir, 'out');
    if (!existsSync(path.join(out, 'index.html'))) {
      return c.json({
        ok: false,
        message: 'Збірка не збереглася на диску — переглянути нічого. '
          + 'Скриншоти з QA нижче показують, як сторінка виглядала. '
          + 'Щоб отримати живий preview, запусти ще одну ітерацію.',
      }, 409);
    }

    await ensureDemoServer();
    const token = registerPreview(projectId, out);
    const url = `${config.deploy.demoBaseUrl.replace(/\/+$/, '')}/${token}/`;
    log.info('preview mounted', { projectId, out, url });
    return c.json({ ok: true, url });
  });

  /**
   * Write Roman's own note into the workspace as a QA issue.
   *
   * The builder's fix iteration reads `QA-ISSUES.md` first, so this is the
   * channel by which a human instruction reaches the agent — in the same file
   * and the same format the automated critic uses, because the builder already
   * knows how to act on that file and inventing a second mechanism would mean
   * two things to keep working.
   *
   * His note goes ABOVE the machine issues and is marked as coming from the
   * owner: when the two disagree, the human is the one to obey.
   */
  app.post('/internal/qa-note/:projectId', internalAuth, async (c) => {
    const projectId = Number(c.req.param('projectId'));
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return c.json({ ok: false, message: 'invalid project id' }, 400);
    }
    const body = await c.req.json().catch(() => null) as { note?: string } | null;
    const note = String(body?.note ?? '').trim();
    if (!note) return c.json({ ok: false, message: 'порожня нотатка' }, 400);

    const [project] = await db.select().from(schema.siteProjects)
      .where(eq(schema.siteProjects.id, projectId));
    if (!project) return c.json({ ok: false, message: 'проєкт не знайдено' }, 404);
    if (!existsSync(path.join(project.dir, 'package.json'))) {
      return c.json({
        ok: false,
        message: 'Воркспейс цієї збірки більше не на диску — ітерацію не запустити. '
          + 'Запусти збірку заново з картки бізнесу.',
      }, 409);
    }

    const previous = existsSync(path.join(project.dir, 'QA-ISSUES.md'))
      ? await readFile(path.join(project.dir, 'QA-ISSUES.md'), 'utf8')
      : '';

    await writeQaIssues(project.dir, `# QA issues — правка від власника

## Найголовніше: це замовив Роман, власник продукту

Він подивився на зібрану сторінку і сказав саме це. Це має пріоритет над усім
нижче: якщо його вимога суперечить якомусь автоматичному зауваженню, виконуй
його. Все, про що він не написав, лишай як є — сторінка вже пройшла три
ітерації, і переробляти те, що працює, не треба.

> ${note.split('\n').join('\n> ')}

Коли закінчиш: \`pnpm build\` зелений, \`out/index.html\` на місці, потім напиши
\`result.json\`.

---

${previous || '(попередніх автоматичних зауважень у воркспейсі немає)'}
`);

    log.info('human QA note written', { projectId, dir: project.dir, chars: note.length });
    return c.json({ ok: true, message: 'нотатку записано' });
  });

  /**
   * The live build log for one project — what the agent is doing right now.
   *
   * A build runs for an hour and the console could previously only say
   * «Виконується», which is indistinguishable from a hung job. This is the
   * read side of `src/build/buildLog.ts`: the file is written by
   * `factory-build` into the shared `sitesdata` volume, and this process (which
   * mounts the same volume) tails it by byte offset.
   *
   * Read-only by construction: there is no way to influence a running build
   * from here, and no way to start one.
   *
   * `after` is the byte offset from the previous poll. `active` comes from
   * workflow_jobs rather than from the project state, because "the project says
   * building" and "a job is actually running" are exactly the two things that
   * disagree when something is wrong — which is the case this panel exists for.
   */
  app.get('/internal/build-log/:businessId', internalAuth, async (c) => {
    // Keyed by BUSINESS: the pipeline log spans design → build → QA → deploy,
    // and the design stage runs before any project row exists. The newest
    // project (when there is one) contributes its state and terminal, as
    // attributes rather than as the key.
    const businessId = c.req.param('businessId');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(businessId)) {
      return c.json({ ok: false, message: 'invalid business id' }, 400);
    }
    const after = Number(c.req.query('after') ?? 0);

    const [biz] = await db.select({ id: schema.businesses.id }).from(schema.businesses)
      .where(eq(schema.businesses.id, businessId));
    if (!biz) return c.json({ ok: false, message: 'бізнес не знайдено' }, 404);

    const [project] = await db.select().from(schema.siteProjects)
      .where(eq(schema.siteProjects.businessId, businessId))
      .orderBy(desc(schema.siteProjects.id))
      .limit(1);

    // The most recent build-ish job for this business. `running` is the live
    // state; `retry_wait` counts as active too — the job is parked waiting for
    // a subscription window, which is progress, not a stall.
    const [job] = await db.select().from(schema.workflowJobs)
      .where(and(
        eq(schema.workflowJobs.businessId, businessId),
        inArray(schema.workflowJobs.jobType, ['content-and-design', 'build-site', 'visual-qa', 'deploy-demo']),
      ))
      .orderBy(desc(schema.workflowJobs.createdAt))
      .limit(1);

    const tail = await readBuildLog(buildLogPath(businessId), after);

    // Whether Roman can attach to the REAL terminal of this build right now.
    // Production asks the runner gateway because tmux lives in the isolated
    // executor; explicit local-development mode reads the marker directly.
    const marker = project?.dir
      ? usesRemoteAgentTransport()
        ? await remoteAgentTransport.terminal('status', project.dir).catch((error) => {
            log.warn('runner terminal status unavailable', {
              businessId, err: String(error).slice(0, 200),
            });
            return null;
          })
        : await liveTerminal(project.dir)
      : null;

    return c.json({
      ok: true,
      lines: tail.lines,
      nextOffset: tail.nextOffset,
      lastEventAgoSec: tail.lastEventAgoSec,
      size: tail.size,
      terminal: marker
        ? {
            session: marker.session,
            // A URL only when one is actually configured AND a server is up;
            // otherwise the UI says how to attach over SSH instead of offering
            // a link that would 404.
            url: marker.served ? config.build.terminalBaseUrl || null : null,
            // New markers record the effective value per runtime. Codex runs a
            // non-interactive `exec`, so even a globally writable terminal must
            // stay a spectator view. Old Claude markers fall back to config.
            writable: marker.writable ?? config.build.terminalWritable,
            startedAt: marker.startedAt,
            // ttyd's basic-auth pair, ONLY when a terminal is actually being
            // served. Roman opened the link and hit a browser password prompt
            // with nothing anywhere telling him the password — it is derived
            // from INTERNAL_API_KEY (see terminalServer.ts) and therefore
            // written down nowhere he can reach.
            //
            // Not a widening of access: this endpoint is already behind
            // `internalAuth`, its only caller is a console page behind the UI
            // password, and anyone holding INTERNAL_API_KEY can derive this
            // value themselves. Withheld when no server is up, so the pair is
            // never handed out for a terminal that does not exist.
            user: marker.served
              ? ('user' in marker ? marker.user : TERMINAL_USER) ?? null
              : null,
            password: marker.served
              ? ('password' in marker ? marker.password : terminalPassword()) || null
              : null,
          }
        : null,
      active: job?.status === 'running' || job?.status === 'retry_wait',
      jobStatus: job?.status ?? null,
      jobType: job?.jobType ?? null,
      // Since the job actually started, not since it was enqueued: the queue
      // wait is not build time and showing it as such would misreport a stall.
      runningForSec: job?.startedAt && (job.status === 'running' || job.status === 'retry_wait')
        ? Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000))
        : null,
      projectState: project?.state ?? null,
    });
  });

  /**
   * WhatsApp inbound from WAHA (decision #2 — NOT the Meta Cloud API).
   * WAHA is configured with WHATSAPP_HOOK_URL pointing here and
   * WHATSAPP_HOOK_EVENTS=message.
   *
   * Authentication is two-layered and both layers are optional-but-recommended:
   *  - X-Api-Key must equal WAHA_API_KEY (WAHA echoes it via
   *    WHATSAPP_HOOK_CUSTOM_HEADERS), and
   *  - X-Webhook-Hmac must be HMAC-SHA512 of the RAW body under
   *    WAHA_HOOK_HMAC_KEY.
   * The raw text is read before parsing precisely because the HMAC is over
   * the exact bytes — re-serialized JSON would not match.
   */
  app.post('/webhooks/waha', async (c) => {
    const raw = await c.req.text();

    if (!verifyApiKey(c.req.header('x-api-key'))) {
      log.warn('WAHA webhook rejected: bad api key', { ip: c.req.header('x-forwarded-for') ?? null });
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    if (!verifyHmac(raw, c.req.header('x-webhook-hmac'))) {
      log.warn('WAHA webhook rejected: bad hmac');
      return c.json({ ok: false, error: 'bad signature' }, 401);
    }

    let envelope: unknown = null;
    try { envelope = JSON.parse(raw); } catch {
      return c.json({ ok: false, error: 'invalid json' }, 400);
    }

    // Always 200 after authentication: a processing error must not make WAHA
    // retry the same inbound message forever.
    const result = await handleWahaWebhook(envelope as any)
      .catch((err) => {
        log.error('WAHA webhook processing failed', { err: String(err) });
        return { handled: false as const, reason: 'error' };
      });
    return c.json({ ok: true, ...result });
  });

  serve({ fetch: app.fetch, port: config.dashboardPort });
  log.info('factory api up', { port: config.dashboardPort, ui: config.ui.baseUrl });

  // Demo static server: private demos are noindex (SPEC §8).
  //
  // This MUST be `startDemoServer()` and not a second static handler. A Next
  // static export requests its chunks at a ROOT-absolute `/_next/...`, while a
  // private demo is served from `/<token>/` — so a plain static root serves the
  // HTML with 200 and 404s every chunk, font and photo, i.e. an unstyled page
  // that no status-code health check notices. `serveDir.ts` re-roots those
  // requests via the Referer token and is the only implementation that does;
  // duplicating a static handler here is what regressed it before.
  await startDemoServer();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((err) => {
    log.error('api failed to start', { err: String(err) });
    process.exit(1);
  });
}
