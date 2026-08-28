/**
 * Trusted runner gateway: validates factory requests, stages one workspace,
 * forwards execution, streams telemetry, then synchronizes allowed outputs.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import {
  ExecutionRequestSchema,
  ExecutionResponseSchema,
  AccountControlRequestSchema,
  AgentCheckRequestSchema,
  ControlResponseSchema,
  TerminalControlRequestSchema,
  RUNNER_MAX_REQUEST_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type ExecutionRequest,
  type ExecutionResponse,
} from './protocol.js';
import {
  executionPaths,
  pumpBuildLog,
  pruneRunnerWork,
  readManifest,
  resolveRunnerPath,
  runnerRoots,
  stageAttachments,
  stageBuildLog,
  stageWorkspace,
  syncWorkspace,
  writeManifest,
} from './workspace.js';
import { liveTerminal } from '../agents/tmuxRuntime.js';
import { TERMINAL_USER, terminalPassword } from '../agents/terminalServer.js';

interface ActiveExecution {
  requestId: string;
  workspaceKey?: string;
  scratchWorkspace: string;
  startedAt: string;
}

const activeByRequest = new Map<string, ActiveExecution>();
const activeByWorkspace = new Map<string, ActiveExecution>();
const workspaceReservations = new Map<string, string>();
const responseCache = new Map<string, { hash: string; response: ExecutionResponse }>();
const inFlight = new Map<string, { hash: string; promise: Promise<ExecutionResponse> }>();

function authorized(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function parseJson(c: Context): Promise<unknown> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > RUNNER_MAX_REQUEST_BYTES) throw new Error('request body too large');
  const text = await c.req.text();
  if (Buffer.byteLength(text) > RUNNER_MAX_REQUEST_BYTES) throw new Error('request body too large');
  return JSON.parse(text);
}

function requestHash(request: ExecutionRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function workspaceKey(request: ExecutionRequest): string | undefined {
  return request.workspace ? `${request.workspace.root}:${request.workspace.path}` : undefined;
}

async function callExecutor(request: ExecutionRequest): Promise<ExecutionResponse> {
  const url = (process.env.RUNNER_EXECUTOR_URL ?? 'http://agent-runner-executor:8791').replace(/\/+$/, '');
  const key = process.env.EXECUTOR_API_KEY ?? '';
  if (!key) throw new Error('EXECUTOR_API_KEY is not configured');
  const timeoutMs = request.options.timeoutMs ?? (request.operation === 'code' ? 60 * 60_000 : 10 * 60_000);
  const response = await fetch(`${url}/v1/executions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-executor-key': key,
      'x-request-id': request.requestId,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs + 30_000),
  });
  const decoded = await response.json().catch(() => null);
  const parsed = ExecutionResponseSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.requestId !== request.requestId) {
    throw new Error(`executor returned invalid response (HTTP ${response.status})`);
  }
  return parsed.data;
}

async function proxyControl(
  endpoint: '/v1/accounts' | '/v1/checks' | '/v1/terminals',
  body: unknown,
): Promise<unknown> {
  const url = (process.env.RUNNER_EXECUTOR_URL ?? 'http://agent-runner-executor:8791').replace(/\/+$/, '');
  const key = process.env.EXECUTOR_API_KEY ?? '';
  if (!key) throw new Error('EXECUTOR_API_KEY is not configured');
  const response = await fetch(`${url}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-executor-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(endpoint === '/v1/checks' ? 2 * 60_000 : 30_000),
  });
  const decoded = await response.json().catch(() => null);
  const parsed = ControlResponseSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`executor returned invalid control response (HTTP ${response.status})`);
  return parsed.data;
}

async function performThroughGateway(
  request: ExecutionRequest,
  hash: string,
): Promise<ExecutionResponse> {
  const roots = runnerRoots();
  const paths = executionPaths(request.requestId, roots);
  await mkdir(paths.root, { recursive: true });
  const manifest = await readManifest(paths.manifest);
  if (manifest && manifest.requestHash !== hash) {
    throw new Error('persisted request id belongs to a different payload');
  }

  let sourceWorkspace: string | undefined;
  if (request.workspace) sourceWorkspace = await resolveRunnerPath(request.workspace, roots);
  if (!manifest) {
    if (sourceWorkspace) await stageWorkspace(sourceWorkspace, paths.workspace);
    else await mkdir(paths.workspace, { recursive: true });
    if (request.operation === 'structured') {
      await stageAttachments(request.attachments, paths.root, roots);
    }
    await writeManifest(paths.manifest, {
      version: 1,
      requestId: request.requestId,
      operation: request.operation,
      requestHash: hash,
      sourceWorkspace: request.workspace,
      sourceBuildLog: request.buildLog,
      createdAt: new Date().toISOString(),
    });
  }

  let sourceBuildLog: string | undefined;
  let logOffset = 0;
  if (request.buildLog) {
    sourceBuildLog = await resolveRunnerPath(request.buildLog, roots, { mustExist: false });
    if (!manifest) logOffset = await stageBuildLog(sourceBuildLog, paths.buildLog);
    else logOffset = await stat(sourceBuildLog).then((value) => value.size).catch(() => 0);
  }

  const active: ActiveExecution = {
    requestId: request.requestId,
    workspaceKey: workspaceKey(request),
    scratchWorkspace: paths.workspace,
    startedAt: new Date().toISOString(),
  };
  activeByRequest.set(request.requestId, active);
  if (active.workspaceKey) activeByWorkspace.set(active.workspaceKey, active);

  let pumpChain = Promise.resolve();
  const pump = (): void => {
    if (!sourceBuildLog) return;
    pumpChain = pumpChain.then(async () => {
      logOffset = await pumpBuildLog(paths.buildLog, sourceBuildLog!, logOffset);
    }).catch(() => undefined);
  };
  const timer = sourceBuildLog ? setInterval(pump, 1_000) : null;
  timer?.unref?.();

  let response: ExecutionResponse;
  try {
    response = await callExecutor(request);
  } catch (error) {
    response = {
      version: RUNNER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: {
        code: 'RUNNER_UNAVAILABLE',
        message: `runner executor unavailable: ${error instanceof Error ? error.message : String(error)}`,
        runtime: request.runtime,
      },
    };
  } finally {
    if (timer) clearInterval(timer);
    pump();
    await pumpChain;
    // Code-agent failures may still have produced a valid deliverable. Sync in
    // every outcome; the factory's invocation-aware recovery decides whether it
    // is current and independently verifies it.
    if (request.operation === 'code' && sourceWorkspace) {
      try {
        const relativeBuildLog = sourceBuildLog
          ? path.relative(sourceWorkspace, sourceBuildLog)
          : '';
        const buildLogInsideWorkspace = relativeBuildLog
          && !relativeBuildLog.startsWith('..')
          && !path.isAbsolute(relativeBuildLog);
        await syncWorkspace(paths.workspace, sourceWorkspace, {
          // The telemetry pump is the sole writer of the factory-side log.
          // Mirroring the staged pre-run copy over it would erase live events.
          preserveRelativePaths: buildLogInsideWorkspace ? [relativeBuildLog] : [],
        });
      } catch (error) {
        response = {
          version: RUNNER_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'RUNNER_UNAVAILABLE',
            message: `runner could not synchronize workspace: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
            runtime: request.runtime,
          },
        };
      }
    }
    activeByRequest.delete(request.requestId);
    if (active.workspaceKey && activeByWorkspace.get(active.workspaceKey)?.requestId === request.requestId) {
      activeByWorkspace.delete(active.workspaceKey);
    }
  }

  responseCache.set(request.requestId, { hash, response });
  if (responseCache.size > 200) {
    const oldest = responseCache.keys().next().value as string | undefined;
    if (oldest) responseCache.delete(oldest);
  }
  return response;
}

async function runThroughGateway(request: ExecutionRequest): Promise<ExecutionResponse> {
  const hash = requestHash(request);
  const cached = responseCache.get(request.requestId);
  if (cached) {
    if (cached.hash !== hash) throw new Error('request id was reused with a different payload');
    return cached.response;
  }
  const running = inFlight.get(request.requestId);
  if (running) {
    if (running.hash !== hash) throw new Error('active request id collision');
    return running.promise;
  }

  const key = workspaceKey(request);
  if (key) {
    const owner = workspaceReservations.get(key);
    if (owner && owner !== request.requestId) {
      throw new Error(`workspace already has an active runner request: ${owner}`);
    }
    workspaceReservations.set(key, request.requestId);
  }

  const promise = performThroughGateway(request, hash).finally(() => {
    inFlight.delete(request.requestId);
    if (key && workspaceReservations.get(key) === request.requestId) workspaceReservations.delete(key);
  });
  inFlight.set(request.requestId, { hash, promise });
  return promise;
}

export function createGatewayApp(): Hono {
  const app = new Hono();
  app.get('/health', async (c) => {
    const executorUrl = (process.env.RUNNER_EXECUTOR_URL ?? 'http://agent-runner-executor:8791').replace(/\/+$/, '');
    const executor = await fetch(`${executorUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok).catch(() => false);
    return c.json({ ok: executor, role: 'gateway', executor, active: activeByRequest.size }, executor ? 200 : 503);
  });
  app.post('/v1/executions', async (c) => {
    if (!authorized(c.req.header('x-runner-key') ?? '', process.env.RUNNER_API_KEY ?? '')) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        requestId: requestIdFrom(c),
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid runner credential' },
      }, 401);
    }
    try {
      const parsed = ExecutionRequestSchema.safeParse(await parseJson(c));
      if (!parsed.success) {
        return c.json({
          version: RUNNER_PROTOCOL_VERSION,
          requestId: requestIdFrom(c),
          ok: false,
          error: { code: 'INVALID_REQUEST', message: parsed.error.message.slice(0, 1_000) },
        }, 400);
      }
      return c.json(await runThroughGateway(parsed.data));
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        requestId: requestIdFrom(c),
        ok: false,
        error: { code: 'INVALID_REQUEST', message: String(error).slice(0, 1_000) },
      }, 400);
    }
  });
  app.post('/v1/checks', async (c) => {
    if (!authorized(c.req.header('x-runner-key') ?? '', process.env.RUNNER_API_KEY ?? '')) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid runner credential' },
      }, 401);
    }
    try {
      const request = AgentCheckRequestSchema.parse(await parseJson(c));
      return c.json(await proxyControl('/v1/checks', request));
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'RUNNER_UNAVAILABLE', message: String(error).slice(0, 1_000) },
      }, 503);
    }
  });
  app.post('/v1/accounts', async (c) => {
    if (!authorized(c.req.header('x-runner-key') ?? '', process.env.RUNNER_API_KEY ?? '')) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid runner credential' },
      }, 401);
    }
    try {
      const request = AccountControlRequestSchema.parse(await parseJson(c));
      return c.json(await proxyControl('/v1/accounts', request));
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'RUNNER_UNAVAILABLE', message: String(error).slice(0, 1_000) },
      }, 503);
    }
  });
  app.post('/v1/terminals', async (c) => {
    if (!authorized(c.req.header('x-runner-key') ?? '', process.env.RUNNER_API_KEY ?? '')) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid runner credential' },
      }, 401);
    }
    try {
      const request = TerminalControlRequestSchema.parse(await parseJson(c));
      const current = activeByWorkspace.get(`${request.workspace.root}:${request.workspace.path}`);
      if (!current) {
        return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: null });
      }
      if (request.operation === 'cancel') {
        return c.json(await proxyControl('/v1/terminals', {
          version: RUNNER_PROTOCOL_VERSION,
          operation: 'cancel',
          requestId: current.requestId,
        }));
      }
      const marker = await liveTerminal(current.scratchWorkspace);
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: true,
        data: marker ? {
          ...marker,
          user: marker.served ? TERMINAL_USER : null,
          password: marker.served
            ? terminalPassword(process.env.EXECUTOR_API_KEY ?? '') || null
            : null,
        } : null,
      });
    } catch (error) {
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'RUNNER_UNAVAILABLE', message: String(error).slice(0, 1_000) },
      }, 503);
    }
  });
  return app;
}

function requestIdFrom(c: Context): string {
  const header = c.req.header('x-request-id') ?? '';
  return /^[0-9a-f-]{36}$/i.test(header) ? header : '00000000-0000-4000-8000-000000000000';
}

export async function startGateway(): Promise<void> {
  const removed = await pruneRunnerWork().catch(() => 0);
  const port = Number(process.env.RUNNER_GATEWAY_PORT ?? 8790);
  serve({ fetch: createGatewayApp().fetch, port, hostname: '0.0.0.0' });
  const cleanup = setInterval(() => { void pruneRunnerWork(); }, 6 * 60 * 60_000);
  cleanup.unref?.();
  console.log(JSON.stringify({ level: 'info', msg: 'agent runner gateway ready', port, removed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startGateway().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
