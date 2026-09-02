/**
 * Untrusted-runtime execution service.
 *
 * It sees one staged scratch directory and provider auth, but no factory DB,
 * object storage or business volumes. OS/network confinement surrounds every
 * tool subprocess; this service is the protocol and lifecycle boundary.
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import {
  ExecutionRequestSchema,
  AccountControlRequestSchema,
  AgentCheckRequestSchema,
  ExecutorTerminalRequestSchema,
  RUNNER_PROTOCOL_VERSION,
  type ExecutionRequest,
  type ExecutionResponse,
  type RunnerError,
  type AccountControlRequest,
} from './protocol.js';
import { executionPaths, runnerRoots } from './workspace.js';
import { executeCodeAgentLocally, getRuntimeById } from '../agents/runtime.js';
import {
  AgentSchemaError,
  isRateLimitedError,
  type AgentRuntimeId,
  type AgentUsage,
  type CodeAgentInvocationContext,
} from '../agents/types.js';
import {
  activeSession,
  cancelSession,
  disconnect,
  startSession,
  submitCode,
  connectOpenCode,
  disconnectOpenCode,
  openCodeAccountStatus,
} from '../api/accounts.js';
import { runLocalAgentCheck } from '../api/checks.js';
import {
  loadRunnerCredentials,
  refreshRunnerSensitiveValues,
  runnerSensitiveValues,
  seedRunnerClaudeCredential,
} from './credentials.js';
import { cancelTmuxSession, liveTerminal } from '../agents/tmuxRuntime.js';
import { runConstrainedPackageCommand } from '../agents/confinement.js';
import { startRunnerProviderBroker } from './providerBroker.js';
import {
  initializeRunnerIsolation,
  runnerIsolationLive,
  type RunnerIsolationReport,
} from './health.js';
import { redactSensitiveText } from '../lib/redaction.js';
import { assertNoSecretLeaks, RunnerSecurityError } from './secretScan.js';
import {
  parseRunnerJson,
  runnerCredentialAuthorized,
  safeRunnerError,
} from './httpBoundary.js';
import {
  agentCapacityManager,
  ResizableSemaphore,
  withAgentWorkerGroup,
} from '../agents/semaphore.js';

const responseCache = new Map<string, { hash: string; response: ExecutionResponse }>();
const active = new Map<string, { hash: string; promise: Promise<ExecutionResponse> }>();
const RESPONSE_CACHE_LIMIT = 200;
/** ttyd exposes one port, so only attachable sessions are globally serialized. */
const terminalExecutions = new ResizableSemaphore(1);
let isolationReport: RunnerIsolationReport = {
  required: true,
  ready: false,
  codeRuntimes: { 'claude-code': false, codex: false, opencode: false },
};

function serializeError(error: unknown, runtime: AgentRuntimeId): RunnerError {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  if (isRateLimitedError(error)) {
    return {
      code: 'RATE_LIMITED',
      message,
      retryAfterMs: error.retryAfterMs,
      rateLimitType: error.rateLimitType,
      resetsAt: error.resetsAt?.toISOString(),
      runtime: error.runtime,
    };
  }
  if (error instanceof AgentSchemaError || (error as { code?: string } | null)?.code === 'NEEDS_HUMAN') {
    return { code: 'NEEDS_HUMAN', message, runtime };
  }
  if (error instanceof RunnerSecurityError) {
    return { code: 'SECURITY_VIOLATION', message, runtime };
  }
  return { code: 'EXECUTION_FAILED', message, runtime };
}

async function installWorkspaceDependencies(cwd: string, timeoutMs: number): Promise<void> {
  if (!existsSync(path.join(cwd, 'package.json'))) return Promise.resolve();
  const limit = Math.min(timeoutMs, 20 * 60_000);
  const install = await runConstrainedPackageCommand(
    cwd,
    ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
    limit,
  );
  if (install.timedOut || install.code !== 0) {
    throw new Error(
      `runner dependency install ${install.timedOut ? 'timed out' : `exited ${install.code}`}: ` +
      install.output.slice(-1_000),
    );
  }
  // esbuild's optional platform package is already in the lockfile. Its rebuild
  // runs after the untrusted graph is present, still inside the same OS sandbox.
  const rebuild = await runConstrainedPackageCommand(
    cwd,
    ['pnpm', 'rebuild', 'esbuild'],
    limit,
    false,
  );
  if (rebuild.timedOut || rebuild.code !== 0) {
    throw new Error(
      `runner dependency rebuild ${rebuild.timedOut ? 'timed out' : `exited ${rebuild.code}`}: ` +
      rebuild.output.slice(-1_000),
    );
  }
}

async function executeInWorkerGroup(request: ExecutionRequest): Promise<ExecutionResponse> {
  const paths = executionPaths(request.requestId);
  const runtime = getRuntimeById(request.runtime);
  let usage: AgentUsage | undefined;
  const onUsage = (value: AgentUsage): void => { usage = value; };

  try {
    if (request.claudeCredential) await seedRunnerClaudeCredential(request.claudeCredential);
    // Codex/OpenCode login files may have changed since executor startup. Load
    // their latest values before any CLI output can reach logs.
    await refreshRunnerSensitiveValues();
    if (request.operation === 'structured') {
      const value = await runtime.structured(
        request.name,
        request.systemPrompt,
        request.userContent,
        z.unknown(),
        {
          ...request.options,
          cwd: paths.workspace,
          imagePaths: request.attachments.map((attachment) => path.join(paths.workspace, attachment.target)),
          buildLogPath: request.buildLog ? paths.buildLog : undefined,
          model: request.model,
          outputJsonSchema: request.outputJsonSchema,
          onUsage,
        },
      );
      return {
        version: RUNNER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        value,
        usage,
      };
    }

    await installWorkspaceDependencies(paths.workspace, request.options.timeoutMs ?? 60 * 60_000);
    const invocation: CodeAgentInvocationContext = Object.freeze({
      invocationId: request.invocation.id,
      workspace: paths.workspace,
      resultPath: path.join(paths.workspace, 'result.json'),
      notBeforeMs: request.invocation.notBeforeMs,
    });
    const run = () => executeCodeAgentLocally(
      {
        name: request.name,
        cwd: paths.workspace,
        prompt: request.prompt,
        appendSystemPrompt: request.appendSystemPrompt,
        ...request.options,
        buildLogPath: request.buildLog ? paths.buildLog : undefined,
        model: request.model,
        outputJsonSchema: request.outputJsonSchema,
        terminalSession: `build-${request.requestId}`,
        onUsage,
      },
      z.unknown(),
      invocation,
      runtime,
    );
    const value = request.options.terminal
      ? await terminalExecutions.run(`terminal:${request.name}`, run)
      : await run();
    await assertNoSecretLeaks(paths.root, await runnerSensitiveValues());
    return {
      version: RUNNER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      value,
      usage,
    };
  } catch (error) {
    let finalError = error;
    if (request.operation === 'code') {
      try {
        await assertNoSecretLeaks(paths.root, await runnerSensitiveValues());
      } catch (securityError) {
        finalError = securityError;
      }
    }
    return {
      version: RUNNER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: serializeError(finalError, request.runtime),
      usage,
    };
  }
}

async function execute(request: ExecutionRequest): Promise<ExecutionResponse> {
  agentCapacityManager.resize(request.capacity.group, request.capacity.limit);
  return withAgentWorkerGroup(
    request.capacity.group,
    () => executeInWorkerGroup(request),
  );
}

async function executeOnce(request: ExecutionRequest): Promise<ExecutionResponse> {
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const cached = responseCache.get(request.requestId);
  if (cached) {
    if (cached.hash !== hash) throw new Error('request id was reused with a different payload');
    return cached.response;
  }
  const running = active.get(request.requestId);
  if (running) {
    if (running.hash !== hash) throw new Error('active request id collision');
    return running.promise;
  }

  const promise = execute(request).then((response) => {
    responseCache.set(request.requestId, { hash, response });
    if (responseCache.size > RESPONSE_CACHE_LIMIT) {
      const oldest = responseCache.keys().next().value as string | undefined;
      if (oldest) responseCache.delete(oldest);
    }
    return response;
  }).finally(() => active.delete(request.requestId));
  active.set(request.requestId, { hash, promise });
  return promise;
}

/** OpenCode has no CLI session: status lists providers, connect/disconnect edit auth.json. */
async function openCodeAccountControl(request: AccountControlRequest): Promise<Record<string, unknown>> {
  if (request.operation === 'status') return { ok: true, session: null, ...(await openCodeAccountStatus()) };
  if (request.operation === 'connect') {
    if (!request.providerId || !request.secret) throw new Error('connect needs providerId and secret');
    return { ok: true, session: await connectOpenCode(request.providerId, request.secret) };
  }
  if (request.operation === 'disconnect') return await disconnectOpenCode(request.providerId ?? '');
  throw new Error(`operation ${request.operation} is not an OpenCode account operation`);
}

/**
 * `startExecutor()` runs the real isolation probe before serving. Tests that
 * mount the app in-process pass their own report; without one the app stays
 * fail-closed (503) until the probe has run.
 */
export function createExecutorApp(overrides: { isolationReport?: RunnerIsolationReport } = {}): Hono {
  const app = new Hono();
  const currentReport = (): RunnerIsolationReport => overrides.isolationReport ?? isolationReport;
  const guardRequest = async (c: Context, requestId?: string): Promise<Response | undefined> => {
    if (!runnerCredentialAuthorized(c.req.header('x-executor-key') ?? '', process.env.EXECUTOR_API_KEY ?? '')) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ...(requestId ? { requestId } : {}),
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid executor credential' },
      }, 401);
    }
    if (!await runnerIsolationLive(currentReport())) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ...(requestId ? { requestId } : {}),
        ok: false,
        error: { code: 'RUNNER_UNAVAILABLE', message: 'runner isolation boundary is unavailable' },
      }, 503);
    }
    return undefined;
  };
  app.get('/health', async (c) => {
    const live = await runnerIsolationLive(currentReport());
    return c.json({
      ok: live,
      role: 'executor',
      active: active.size,
      isolation: isolationReport,
    }, live ? 200 : 503);
  });
  app.post('/v1/executions', async (c) => {
    const requestId = randomRequestId(c);
    const guarded = await guardRequest(c, requestId);
    if (guarded) return guarded;
    try {
      const parsed = ExecutionRequestSchema.safeParse(await parseRunnerJson(c));
      if (!parsed.success) {
        return c.json({
          version: RUNNER_PROTOCOL_VERSION,
          requestId: randomRequestId(c),
          ok: false,
          error: { code: 'INVALID_REQUEST', message: parsed.error.message.slice(0, 1_000) },
        }, 400);
      }
      return c.json(await executeOnce(parsed.data));
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        requestId: randomRequestId(c),
        ok: false,
        error: { code: 'INVALID_REQUEST', message: safeRunnerError(error) },
      }, 400);
    }
  });
  app.post('/v1/checks', async (c) => {
    const guarded = await guardRequest(c);
    if (guarded) return guarded;
    try {
      const request = AgentCheckRequestSchema.parse(await parseRunnerJson(c));
      if (request.claudeCredential) await seedRunnerClaudeCredential(request.claudeCredential);
      await refreshRunnerSensitiveValues();
      const result = await runLocalAgentCheck(request.provider, request.model);
      return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: result });
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: safeRunnerError(error) },
      }, 400);
    }
  });
  app.post('/v1/accounts', async (c) => {
    const guarded = await guardRequest(c);
    if (guarded) return guarded;
    try {
      const request = AccountControlRequestSchema.parse(await parseRunnerJson(c));
      if (request.provider === 'opencode') {
        return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: await openCodeAccountControl(request) });
      }
      if (request.operation === 'connect') {
        throw new Error(`${request.provider} connects through its CLI login session, not a stored key`);
      }
      if (request.operation === 'start') {
        return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: { ok: true, session: startSession(request.provider) } });
      }
      if (request.operation === 'status') {
        return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: { ok: true, session: activeSession(request.provider) } });
      }
      if (request.operation === 'submit-code') {
        return c.json({
          version: RUNNER_PROTOCOL_VERSION,
          ok: true,
          data: { ok: true, session: submitCode(request.provider, request.code ?? '') },
        });
      }
      if (request.operation === 'cancel') {
        return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: { ok: true, session: cancelSession(request.provider) } });
      }
      const result = await disconnect(request.provider);
      return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: result });
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: safeRunnerError(error) },
      }, 400);
    }
  });
  app.post('/v1/terminals', async (c) => {
    const guarded = await guardRequest(c);
    if (guarded) return guarded;
    try {
      const request = ExecutorTerminalRequestSchema.parse(await parseRunnerJson(c));
      const marker = await liveTerminal(executionPaths(request.requestId).workspace);
      if (marker) await cancelTmuxSession(marker.session);
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: true,
        data: { cancelled: Boolean(marker), requestId: request.requestId },
      });
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: safeRunnerError(error) },
      }, 400);
    }
  });
  return app;
}

function randomRequestId(c: Context): string {
  const raw = c.req.header('x-request-id') ?? '';
  return /^[0-9a-f-]{36}$/i.test(raw) ? raw : '00000000-0000-4000-8000-000000000000';
}

export async function startExecutor(): Promise<void> {
  await loadRunnerCredentials();
  // Loopback credential broker for sandboxed OpenCode runs; the isolation
  // probe below checks it is reachable from inside the sandbox.
  const broker = await startRunnerProviderBroker();
  console.log(JSON.stringify({ level: 'info', msg: 'opencode credential broker listening', port: broker.port }));
  isolationReport = await initializeRunnerIsolation();
  const roots = runnerRoots();
  const port = Number(process.env.RUNNER_EXECUTOR_PORT ?? 8791);
  serve({ fetch: createExecutorApp().fetch, port, hostname: '0.0.0.0' });
  console.log(JSON.stringify({ level: 'info', msg: 'agent runner executor ready', port, work: roots.work }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startExecutor().catch((error) => {
    console.error(safeRunnerError(error, 2_000));
    process.exit(1);
  });
}
