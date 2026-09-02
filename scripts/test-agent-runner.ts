/**
 * Offline integration proof for the production agent-runner boundary.
 *
 * Real HTTP servers, protocol validation and filesystem staging/sync are used.
 * The executor itself is a deterministic test double so this suite never burns
 * a Claude/Codex/OpenCode subscription.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';

process.env.AGENT_EXECUTION_MODE = 'remote';
process.env.RUNNER_API_KEY = 'runner-test-key';
process.env.EXECUTOR_API_KEY = 'executor-test-key';
process.env.INTERNAL_API_KEY = 'executor-test-key';

let passed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for test condition');
}

const tmp = await mkdtemp(path.join(tmpdir(), 'factory-runner-'));
const sites = path.join(tmp, 'sites');
const inputs = path.join(tmp, 'inputs');
const work = path.join(tmp, 'work');
await Promise.all([mkdir(sites), mkdir(inputs), mkdir(work)]);
process.env.RUNNER_SITES_ROOT = sites;
process.env.RUNNER_INPUTS_ROOT = inputs;
process.env.RUNNER_WORK_ROOT = work;

const {
  CodeExecutionRequestSchema,
  RunnerPathRefSchema,
  StructuredExecutionRequestSchema,
  RUNNER_MAX_REQUEST_BYTES,
  RUNNER_PROTOCOL_VERSION,
} = await import('../src/runner/protocol.js');
const {
  executionPaths,
  pumpBuildLog,
  pruneRunnerWork,
  stageWorkspace,
  syncWorkspace,
} = await import('../src/runner/workspace.js');
const { Hono } = await import('hono');
const { serve } = await import('@hono/node-server');
const { createGatewayApp } = await import('../src/runner/gateway.js');
const { createExecutorApp } = await import('../src/runner/executor.js');
const { remoteAgentTransport } = await import('../src/agents/remoteTransport.js');
const {
  artifactProducedDuringInvocation,
  prepareCodeAgentInvocation,
} = await import('../src/agents/result.js');
const {
  getRuntimeById,
  runCodeAgent,
} = await import('../src/agents/runtime.js');
const { config } = await import('../src/config.js');
const { isRunnerUnavailableError } = await import('../src/agents/types.js');
const { terminalPassword } = await import('../src/agents/terminalServer.js');
const { confinedCommand, openCodeSandboxEnv } = await import('../src/agents/confinement.js');
const { assertNoSecretLeaks, RunnerSecurityError } = await import('../src/runner/secretScan.js');
const {
  redactSensitiveText,
  redactSensitiveValue,
  setSensitiveValues,
} = await import('../src/lib/redaction.js');
const {
  agentSlotStats,
  currentAgentWorkerGroup,
  withAgentSlot,
} = await import('../src/agents/semaphore.js');

type TestServer = ReturnType<typeof serve>;
async function listen(app: InstanceType<typeof Hono>): Promise<{ server: TestServer; url: string }> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function close(server: TestServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const executorCalls = new Map<string, number>();
let terminalCancels = 0;
const fakeExecutor = new Hono();
fakeExecutor.get('/health', (c) => c.json({ ok: true }));
fakeExecutor.post('/v1/executions', async (c) => {
  if (c.req.header('x-executor-key') !== process.env.EXECUTOR_API_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const request = await c.req.json() as z.infer<typeof CodeExecutionRequestSchema>
    | z.infer<typeof StructuredExecutionRequestSchema>;
  executorCalls.set(request.requestId, (executorCalls.get(request.requestId) ?? 0) + 1);
  if (request.name === 'malformed-executor') return c.text('not-json', 502);

  const paths = executionPaths(request.requestId);
  if (request.operation === 'code') {
    if (request.name === 'security-violation') {
      await writeFile(path.join(paths.workspace, 'blocked-output.txt'), 'must never sync');
      return c.json({
        version: RUNNER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'SECURITY_VIOLATION',
          message: 'runner output failed the security gate',
          runtime: request.runtime,
        },
      });
    }
    if (request.options.terminal) {
      const now = new Date().toISOString();
      await writeFile(path.join(paths.workspace, 'terminal-session.json'), JSON.stringify({
        session: `build-${request.requestId}`,
        served: true,
        writable: false,
        startedAt: now,
        heartbeatAt: now,
      }));
    }
    if (request.name !== 'missing-result') {
      const value = request.name === 'invalid-code-schema'
        ? { ok: 'yes', runtime: 7 }
        : { ok: true, runtime: request.runtime };
      await writeFile(path.join(paths.workspace, 'result.json'), JSON.stringify(value));
    }
    if (request.buildLog) await appendFile(paths.buildLog, '\n{"event":"runner-test"}\n');
  }

  if (request.name.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 250));
  const value = request.name === 'invalid-structured-schema'
    ? { pong: 'not-a-boolean', runtime: request.runtime }
    : request.name === 'attachment-path'
      ? {
        insideWorkspace: existsSync(path.join(paths.workspace, request.attachments[0]!.target)),
        outsideWorkspace: existsSync(path.join(paths.root, request.attachments[0]!.target)),
      }
      : { pong: true, runtime: request.runtime };
  return c.json({
    version: RUNNER_PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    value,
    usage: { runtime: request.runtime, model: request.model, durationMs: 5, numTurns: 1 },
  });
});
fakeExecutor.post('/v1/checks', async (c) => {
  const request = await c.req.json() as { provider: string; model?: string };
  return c.json({
    version: RUNNER_PROTOCOL_VERSION,
    ok: true,
    data: { ok: true, message: `${request.provider} checked`, detail: { model: request.model ?? null } },
  });
});
const accountRequests: Array<{ provider: string; operation: string; providerId?: string; secret?: string }> = [];
fakeExecutor.post('/v1/accounts', async (c) => {
  const request = await c.req.json() as { provider: string; operation: string; providerId?: string; secret?: string };
  accountRequests.push(request);
  return c.json({
    version: RUNNER_PROTOCOL_VERSION,
    ok: true,
    data: request.operation === 'disconnect'
      ? { ok: true, message: `${request.provider} disconnected` }
      : request.operation === 'status' && request.provider === 'opencode'
        ? { ok: true, session: null, providers: [{ id: 'zai-coding-plan', name: 'Z.AI Coding Plan', connected: false }] }
        : {
        ok: true,
        session: {
          provider: request.provider,
          phase: 'awaiting',
          message: 'test session',
          startedAt: Date.now(),
          expiresInMs: 10_000,
        },
      },
  });
});
fakeExecutor.post('/v1/terminals', async (c) => {
  terminalCancels++;
  return c.json({ version: RUNNER_PROTOCOL_VERSION, ok: true, data: { cancelled: true } });
});

let executorServer: TestServer | undefined;
let gatewayServer: TestServer | undefined;

try {
  await check('wire protocol rejects traversal and old versions', () => {
    assert.equal(RunnerPathRefSchema.safeParse({ root: 'sites', path: '../secret' }).success, false);
    assert.equal(StructuredExecutionRequestSchema.safeParse({ version: 0 }).success, false);
  });

  await check('workspace staging is isolated and preserves freshness metadata', async () => {
    const source = path.join(sites, 'staging-source');
    const staged = path.join(tmp, 'staged');
    await mkdir(path.join(source, 'node_modules'), { recursive: true });
    await writeFile(path.join(source, 'index.txt'), 'original');
    await writeFile(path.join(source, 'delete.txt'), 'delete me');
    await writeFile(path.join(source, 'node_modules', 'private-cache'), 'cache');
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(source, 'index.txt'), old, old);

    await stageWorkspace(source, staged);
    assert.equal(await readFile(path.join(staged, 'index.txt'), 'utf8'), 'original');
    assert.equal(existsSync(path.join(staged, 'node_modules')), false);
    const stagedMtime = (await import('node:fs/promises')).stat(path.join(staged, 'index.txt')).then((s) => s.mtimeMs);
    assert.ok(Math.abs(await stagedMtime - old.getTime()) < 5);

    await rm(path.join(staged, 'delete.txt'));
    await writeFile(path.join(staged, 'new.txt'), 'new output');
    await syncWorkspace(staged, source);
    assert.equal(existsSync(path.join(source, 'delete.txt')), false);
    assert.equal(await readFile(path.join(source, 'new.txt'), 'utf8'), 'new output');
    assert.equal(await readFile(path.join(source, 'node_modules', 'private-cache'), 'utf8'), 'cache');
    const syncedMtime = await (await import('node:fs/promises')).stat(path.join(source, 'index.txt'));
    assert.ok(Math.abs(syncedMtime.mtimeMs - old.getTime()) < 5);
  });

  await check('workspace staging rejects symlinks', async () => {
    const source = path.join(sites, 'symlink-source');
    await mkdir(source);
    await symlink(tmp, path.join(source, 'escape'));
    await assert.rejects(stageWorkspace(source, path.join(tmp, 'symlink-stage')), /rejects symlink/);
  });

  await check('runner scratch cleanup is age-based and bounded', async () => {
    const oldId = randomUUID();
    const oldRoot = executionPaths(oldId).root;
    await mkdir(oldRoot);
    const old = new Date(Date.now() - 10_000);
    await utimes(oldRoot, old, old);
    assert.equal(await pruneRunnerWork(undefined, 1_000, new Set([oldId])), 0);
    assert.equal(existsSync(oldRoot), true);
    assert.equal(await pruneRunnerWork(undefined, 1_000), 1);
    assert.equal(existsSync(oldRoot), false);
  });

  await check('build-log pump appends only bytes after its durable offset', async () => {
    const scratch = path.join(tmp, 'pump-scratch.ndjson');
    const destination = path.join(tmp, 'pump-destination.ndjson');
    await writeFile(scratch, 'first\n');
    const firstOffset = await pumpBuildLog(scratch, destination, 0);
    await appendFile(scratch, 'second\n');
    const secondOffset = await pumpBuildLog(scratch, destination, firstOffset);
    assert.equal(firstOffset, 6);
    assert.equal(secondOffset, 13);
    assert.equal(await readFile(destination, 'utf8'), 'first\nsecond\n');
  });

  await check('production wraps OpenCode in the Codex exact-root sandbox with workspace-local XDG', () => {
    const previous = process.env.RUNNER_REQUIRE_ISOLATION;
    process.env.RUNNER_REQUIRE_ISOLATION = 'true';
    try {
      const launch = confinedCommand('opencode', ['run', '--pure'], '/work/ws');
      assert.equal(launch.command, process.env.CODEX_BIN ?? 'codex');
      assert.deepEqual(launch.args, ['sandbox', '-P', 'factory-tools', '-C', '/work/ws', '--', 'opencode', 'run', '--pure']);
      const env = openCodeSandboxEnv('/work/ws');
      for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        assert.ok(env[name]?.startsWith('/work/ws/.factory-tmp/opencode-xdg/'), `${name} must live in the workspace`);
      }
    } finally {
      if (previous === undefined) delete process.env.RUNNER_REQUIRE_ISOLATION;
      else process.env.RUNNER_REQUIRE_ISOLATION = previous;
    }
    const direct = confinedCommand('opencode', ['run'], '/work/ws');
    assert.deepEqual(direct, { command: 'opencode', args: ['run'] });
  });

  await check('runner redacts nested secret values without logging them', () => {
    const secret = 'runner-redaction-secret-value';
    setSensitiveValues([secret]);
    try {
      assert.equal(redactSensitiveText(`before ${secret} after`), 'before [REDACTED] after');
      assert.deepEqual(redactSensitiveValue({ nested: [secret] }), { nested: ['[REDACTED]'] });
    } finally {
      setSensitiveValues([]);
    }
  });

  await check('runner output scan rejects literal credentials before sync', async () => {
    const root = path.join(tmp, 'secret-scan');
    const secret = 'literal-runner-secret-value';
    await mkdir(root);
    await writeFile(path.join(root, 'safe.txt'), 'ordinary output');
    await assertNoSecretLeaks(root, [secret]);
    await writeFile(path.join(root, 'leak.txt'), `copied: ${secret}`);
    await assert.rejects(
      assertNoSecretLeaks(root, [secret]),
      (error: unknown) => error instanceof RunnerSecurityError && error.code === 'SECURITY_VIOLATION',
    );
  });

  await check('runner output scan detects credentials split across stream chunks', async () => {
    const root = path.join(tmp, 'secret-scan-boundary');
    const secret = 'cross-chunk-runner-secret-value';
    await mkdir(root);
    const prefix = Buffer.alloc((64 * 1024) - 4, 0x61);
    await writeFile(path.join(root, 'large-output.bin'), Buffer.concat([
      prefix,
      Buffer.from(secret),
      Buffer.alloc(64 * 1024, 0x62),
    ]));
    await assert.rejects(
      assertNoSecretLeaks(root, [secret]),
      (error: unknown) => error instanceof RunnerSecurityError && error.code === 'SECURITY_VIOLATION',
    );
  });

  await check('runner output scan cannot hide a leak in a nested cache-shaped path', async () => {
    const root = path.join(tmp, 'secret-scan-nested-cache');
    const secret = 'nested-cache-runner-secret-value';
    await mkdir(path.join(root, 'workspace', 'node_modules'), { recursive: true });
    await mkdir(path.join(root, 'workspace', 'output', '.next'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'node_modules', 'ignored.txt'), secret);
    await writeFile(path.join(root, 'workspace', 'output', '.next', 'leak.txt'), secret);
    await assert.rejects(
      assertNoSecretLeaks(root, [secret]),
      (error: unknown) => error instanceof RunnerSecurityError && error.code === 'SECURITY_VIOLATION',
    );
  });

  await check('real executor restores worker-group capacity from the wire request', async () => {
    const runtime = getRuntimeById('claude-code');
    const original = runtime.structured;
    let observedGroup = '';
    let observedLimit = 0;
    runtime.structured = (async () => withAgentSlot('executor-capacity-test', async () => {
      observedGroup = currentAgentWorkerGroup();
      observedLimit = agentSlotStats().limit;
      return { pong: true };
    })) as typeof runtime.structured;
    const requestId = randomUUID();
    await mkdir(executionPaths(requestId).workspace, { recursive: true });
    try {
      // In-process app: stand in for the startup probe that startExecutor()
      // runs, otherwise the readiness guard (correctly) answers 503.
      const response = await createExecutorApp({
        isolationReport: {
          required: false,
          ready: true,
          codeRuntimes: { 'claude-code': true, codex: true, opencode: true },
        },
      }).request('/v1/executions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-executor-key': process.env.EXECUTOR_API_KEY!,
          'x-request-id': requestId,
        },
        body: JSON.stringify(StructuredExecutionRequestSchema.parse({
          version: RUNNER_PROTOCOL_VERSION,
          operation: 'structured',
          requestId,
          runtime: 'claude-code',
          capacity: { group: 'enrich', limit: 3 },
          name: 'executor-capacity',
          systemPrompt: 'system',
          userContent: 'user',
          outputJsonSchema: { type: 'object' },
          attachments: [],
          options: { retries: 0, timeoutMs: 5_000 },
        })),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { ok: boolean }).ok, true);
      assert.equal(observedGroup, 'enrich');
      assert.equal(observedLimit, 3);
    } finally {
      runtime.structured = original;
    }
  });

  const executor = await listen(fakeExecutor);
  executorServer = executor.server;
  process.env.RUNNER_EXECUTOR_URL = executor.url;
  const gateway = await listen(createGatewayApp());
  gatewayServer = gateway.server;
  process.env.RUNNER_GATEWAY_URL = gateway.url;

  const gatewayPost = async (body: unknown, key = process.env.RUNNER_API_KEY ?? ''): Promise<Response> =>
    fetch(`${gateway.url}/v1/executions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runner-key': key,
        'x-request-id': typeof body === 'object' && body && 'requestId' in body
          ? String((body as { requestId: unknown }).requestId)
          : randomUUID(),
      },
      body: JSON.stringify(body),
    });

  const structuredRequest = (overrides: Record<string, unknown> = {}) => StructuredExecutionRequestSchema.parse({
    version: RUNNER_PROTOCOL_VERSION,
    operation: 'structured',
    requestId: randomUUID(),
    runtime: 'claude-code',
    capacity: { group: 'core', limit: 2 },
    model: 'test-model',
    name: 'direct-structured',
    systemPrompt: 'system',
    userContent: 'user',
    outputJsonSchema: { type: 'object' },
    attachments: [],
    options: { retries: 0, timeoutMs: 5_000 },
    ...overrides,
  });

  await check('security-violation output is never synchronized to factory storage', async () => {
    const workspace = path.join(sites, 'security-gated-workspace');
    const invocation = await prepareCodeAgentInvocation(workspace);
    const request = CodeExecutionRequestSchema.parse({
      version: RUNNER_PROTOCOL_VERSION,
      operation: 'code',
      requestId: invocation.invocationId,
      runtime: 'codex',
      capacity: { group: 'build', limit: 2 },
      model: 'test-model',
      name: 'security-violation',
      prompt: 'attempt leak',
      outputJsonSchema: { type: 'object' },
      workspace: { root: 'sites', path: 'security-gated-workspace' },
      invocation: { id: invocation.invocationId, notBeforeMs: invocation.notBeforeMs },
      options: { terminal: false, timeoutMs: 5_000 },
    });
    const response = await gatewayPost(request);
    const body = await response.json() as { ok: boolean; error?: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, 'SECURITY_VIOLATION');
    assert.equal(existsSync(path.join(workspace, 'blocked-output.txt')), false);
  });

  await check('gateway rejects unauthorized, invalid and oversized requests', async () => {
    const request = structuredRequest();
    assert.equal((await gatewayPost(request, 'wrong-key')).status, 401);
    assert.equal((await gatewayPost({ ...request, version: 0 })).status, 400);
    const oversized = await fetch(`${gateway.url}/v1/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runner-key': process.env.RUNNER_API_KEY! },
      body: JSON.stringify({ value: 'x'.repeat(RUNNER_MAX_REQUEST_BYTES + 1) }),
    });
    assert.equal(oversized.status, 400);
  });

  const StructuredResult = z.object({
    pong: z.literal(true),
    runtime: z.enum(['claude-code', 'codex', 'opencode']),
  });
  for (const runtime of ['claude-code', 'codex', 'opencode'] as const) {
    await check(`${runtime} structured request crosses the remote boundary`, async () => {
      const usage: unknown[] = [];
      const value = await remoteAgentTransport.structured(
        runtime,
        `structured-${runtime}`,
        'system',
        'user',
        StructuredResult,
        { model: 'test-model', retries: 0, timeoutMs: 5_000, onUsage: (item) => usage.push(item) },
      );
      assert.deepEqual(value, { pong: true, runtime });
      assert.equal(usage.length, 1);
    });
  }

  await check('structured attachments are staged inside the exact sandbox workspace', async () => {
    const image = path.join(inputs, 'attachment.png');
    await writeFile(image, 'image fixture');
    const value = await remoteAgentTransport.structured(
      'claude-code',
      'attachment-path',
      'system',
      'inspect attachment',
      z.object({ insideWorkspace: z.boolean(), outsideWorkspace: z.boolean() }),
      { imagePaths: [image], retries: 0, timeoutMs: 5_000 },
    );
    assert.deepEqual(value, { insideWorkspace: true, outsideWorkspace: false });
  });

  await check('caller schema remains authoritative after remote execution', async () => {
    await assert.rejects(
      remoteAgentTransport.structured(
        'claude-code',
        'invalid-structured-schema',
        'system',
        'user',
        StructuredResult,
        { model: 'test-model', retries: 0, timeoutMs: 5_000 },
      ),
      /failed caller schema/,
    );
  });

  const CodeResult = z.object({
    ok: z.literal(true),
    runtime: z.enum(['claude-code', 'codex', 'opencode']),
  });
  for (const runtime of ['claude-code', 'codex', 'opencode'] as const) {
    await check(`${runtime} code artifact is synchronized and revalidated`, async () => {
      const workspace = path.join(sites, `code-${runtime}`);
      const invocation = await prepareCodeAgentInvocation(workspace);
      const value = await remoteAgentTransport.code(
        runtime,
        { name: `code-${runtime}`, cwd: workspace, prompt: 'write result', terminal: false, model: 'test-model', timeoutMs: 5_000 },
        CodeResult,
        invocation,
      );
      assert.deepEqual(value, { ok: true, runtime });
      assert.equal(existsSync(path.join(workspace, 'result.json')), true);
    });
  }

  await check('remote code rejects a freshly written artifact with the wrong schema', async () => {
    const workspace = path.join(sites, 'invalid-code');
    const invocation = await prepareCodeAgentInvocation(workspace);
    await assert.rejects(
      remoteAgentTransport.code(
        'codex',
        { name: 'invalid-code-schema', cwd: workspace, prompt: 'bad result', terminal: false, model: 'test-model', timeoutMs: 5_000 },
        CodeResult,
        invocation,
      ),
      /failed schema/,
    );
  });

  await check('remote sync cannot make an old builder output look current', async () => {
    const workspace = path.join(sites, 'reused-output');
    const output = path.join(workspace, 'out', 'index.html');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, '<main>old build</main>');
    const old = new Date(Date.now() - 60_000);
    await utimes(output, old, old);
    const invocation = await prepareCodeAgentInvocation(workspace);
    await remoteAgentTransport.code(
      'claude-code',
      { name: 'does-not-touch-output', cwd: workspace, prompt: 'result only', terminal: false, model: 'test-model', timeoutMs: 5_000 },
      CodeResult,
      invocation,
    );
    assert.equal(await artifactProducedDuringInvocation(output, invocation), false);
  });

  await check('runner telemetry is pumped back to the factory build log', async () => {
    const workspace = path.join(sites, 'telemetry-workspace');
    const buildLog = path.join(workspace, 'build-log.ndjson');
    await mkdir(workspace, { recursive: true });
    await writeFile(buildLog, '{"event":"factory-test"}\n');
    const invocation = await prepareCodeAgentInvocation(workspace);
    await remoteAgentTransport.code(
      'opencode',
      { name: 'telemetry', cwd: workspace, prompt: 'write result', buildLogPath: buildLog, terminal: false, model: 'test-model', timeoutMs: 5_000 },
      CodeResult,
      invocation,
    );
    assert.match(await readFile(buildLog, 'utf8'), /runner-test/);
  });

  await check('duplicate request IDs execute once and payload collisions fail closed', async () => {
    const request = structuredRequest({ name: 'duplicate-slow' });
    const [first, second] = await Promise.all([gatewayPost(request), gatewayPost(request)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(executorCalls.get(request.requestId), 1);
    const collision = await gatewayPost({ ...request, userContent: 'different payload' });
    assert.equal(collision.status, 400);
    assert.equal((await collision.json() as { ok: boolean }).ok, false);
  });

  await check('two request IDs cannot race on the same workspace', async () => {
    const workspace = path.join(sites, 'workspace-race');
    await mkdir(workspace);
    const firstId = randomUUID();
    const base = {
      version: RUNNER_PROTOCOL_VERSION,
      operation: 'code' as const,
      runtime: 'claude-code' as const,
      capacity: { group: 'build' as const, limit: 2 },
      model: 'test-model',
      name: 'workspace-slow',
      prompt: 'result',
      outputJsonSchema: { type: 'object' },
      workspace: { root: 'sites' as const, path: 'workspace-race' },
      invocation: { id: firstId, notBeforeMs: Date.now() },
      options: { terminal: false, timeoutMs: 5_000 },
    };
    const firstRequest = CodeExecutionRequestSchema.parse({ ...base, requestId: firstId });
    const first = gatewayPost(firstRequest);
    await waitFor(() => executorCalls.has(firstId));
    const secondId = randomUUID();
    const secondRequest = CodeExecutionRequestSchema.parse({
      ...base,
      requestId: secondId,
      invocation: { id: secondId, notBeforeMs: Date.now() },
    });
    const second = await gatewayPost(secondRequest);
    assert.equal(second.status, 400);
    assert.match(JSON.stringify(await second.json()), /workspace already has an active/);
    assert.equal((await first).status, 200);
  });

  await check('terminal status/cancel and account/check controls stay behind the gateway', async () => {
    const workspace = path.join(sites, 'terminal-workspace');
    const invocation = await prepareCodeAgentInvocation(workspace);
    const running = remoteAgentTransport.code(
      'claude-code',
      { name: 'terminal-slow', cwd: workspace, prompt: 'result', terminal: true, model: 'test-model', timeoutMs: 5_000 },
      CodeResult,
      invocation,
    );
    const marker = path.join(executionPaths(invocation.invocationId).workspace, 'terminal-session.json');
    await waitFor(() => existsSync(marker));
    const terminal = await remoteAgentTransport.terminal('status', workspace);
    assert.equal(terminal?.session, `build-${invocation.invocationId}`);
    assert.equal(terminal?.password, terminalPassword(process.env.EXECUTOR_API_KEY));
    await remoteAgentTransport.terminal('cancel', workspace);
    assert.equal(terminalCancels, 1);
    await running;

    const account = await remoteAgentTransport.account('status', 'codex');
    assert.equal(account.ok, true);
    const opencodeStatus = await remoteAgentTransport.account('status', 'opencode');
    assert.deepEqual(opencodeStatus.providers, [{ id: 'zai-coding-plan', name: 'Z.AI Coding Plan', connected: false }]);
    await remoteAgentTransport.account('connect', 'opencode', undefined, { providerId: 'zai-coding-plan', secret: 'glm-test-key' });
    const connect = accountRequests.find((r) => r.operation === 'connect');
    assert.deepEqual(connect, { version: RUNNER_PROTOCOL_VERSION, operation: 'connect', provider: 'opencode', providerId: 'zai-coding-plan', secret: 'glm-test-key' });
    const providerCheck = await remoteAgentTransport.check('opencode');
    assert.equal(providerCheck.ok, true);
    assert.match(providerCheck.message, /opencode checked/);
  });

  await check('malformed executor responses become explicit runner failures', async () => {
    await assert.rejects(
      remoteAgentTransport.structured(
        'claude-code',
        'malformed-executor',
        'system',
        'user',
        StructuredResult,
        { model: 'test-model', retries: 0, timeoutMs: 5_000 },
      ),
      (error: unknown) => isRunnerUnavailableError(error),
    );
  });

  await check('remote outage never falls back to a local provider CLI', async () => {
    const previousUrl = process.env.RUNNER_GATEWAY_URL;
    process.env.RUNNER_GATEWAY_URL = 'http://127.0.0.1:1';
    const runtime = getRuntimeById('claude-code');
    const original = runtime.codeAgent;
    const originalRuntimeFor = config.agents.runtimeFor;
    let localCalls = 0;
    runtime.codeAgent = async () => { localCalls++; throw new Error('must not run'); };
    config.agents.runtimeFor = () => 'claude-code';
    try {
      await assert.rejects(
        runCodeAgent(
          { name: 'no-local-fallback', cwd: path.join(sites, 'no-fallback'), prompt: 'result', terminal: false, timeoutMs: 1_000 },
          CodeResult,
        ),
        (error: unknown) => isRunnerUnavailableError(error),
      );
      assert.equal(localCalls, 0);
    } finally {
      runtime.codeAgent = original;
      config.agents.runtimeFor = originalRuntimeFor;
      process.env.RUNNER_GATEWAY_URL = previousUrl;
    }
  });

  console.log(`\n🧾 AGENT RUNNER TESTS PASSED (${passed})`);
} finally {
  if (gatewayServer) await close(gatewayServer);
  if (executorServer) await close(executorServer);
  await rm(tmp, { recursive: true, force: true });
}
