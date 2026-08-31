/** HTTP client for the trusted remote agent-runner gateway. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import {
  AccountControlRequestSchema,
  AgentCheckRequestSchema,
  CodeExecutionRequestSchema,
  ControlResponseSchema,
  ExecutionResponseSchema,
  RUNNER_MAX_REQUEST_BYTES,
  RUNNER_PROTOCOL_VERSION,
  StructuredExecutionRequestSchema,
  TerminalControlRequestSchema,
  type AgentAccountProvider,
  type AgentCheckProvider,
  type RunnerError,
} from '../runner/protocol.js';
import { outputJsonSchema } from './schema.js';
import { effectiveModel } from './modelPolicy.js';
import { readAndValidateResult } from './result.js';
import { currentAgentWorkerGroup } from './semaphore.js';
import {
  AgentSchemaError,
  RateLimitedError,
  RunnerUnavailableError,
  type AgentRuntimeId,
  type AgentUsage,
  type CodeAgentInvocationContext,
  type CodeAgentOptions,
  type StructuredOptions,
} from './types.js';
import {
  runnerPathRef,
  type AccountControlOutcome,
  type AgentCheckOutcome,
  type AgentExecutionTransport,
  type RemoteTerminalInfo,
} from './transport.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function runnerError(error: RunnerError): Error {
  if (error.code === 'RATE_LIMITED') {
    return new RateLimitedError(error.message, {
      retryAfterMs: error.retryAfterMs ?? config.agents.rateLimitDefaultWaitMs,
      rateLimitType: error.rateLimitType,
      resetsAt: error.resetsAt ? new Date(error.resetsAt) : undefined,
      runtime: error.runtime ?? 'claude-code',
    });
  }
  if (error.code === 'NEEDS_HUMAN') return new AgentSchemaError(error.message);
  if (error.code === 'RUNNER_UNAVAILABLE') return new RunnerUnavailableError(error.message);
  const restored = new Error(error.message) as Error & { code?: string };
  restored.code = error.code;
  return restored;
}

function claudeCredential(runtime?: AgentRuntimeId): string | undefined {
  return runtime === 'claude-code'
    && process.env.RUNNER_SEED_CLAUDE_CREDENTIAL === 'true'
    && config.agents.oauthToken
    ? config.agents.oauthToken
    : undefined;
}

function capacity(): { group: 'core' | 'enrich' | 'build'; limit: number } {
  const group = currentAgentWorkerGroup();
  const limit = group === 'build'
    ? config.agents.concurrencyBuild
    : group === 'enrich'
      ? config.agents.concurrencyEnrich
      : config.agents.concurrency;
  return { group, limit };
}

async function post(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const apiKey = config.agents.runnerApiKey;
  if (!apiKey) {
    throw new RunnerUnavailableError('RUNNER_API_KEY is required for remote agent execution');
  }
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > RUNNER_MAX_REQUEST_BYTES) {
    throw new Error(`runner request exceeds ${RUNNER_MAX_REQUEST_BYTES} bytes`);
  }

  let response: Response;
  try {
    const requestId = typeof body === 'object' && body !== null && 'requestId' in body
      ? String((body as { requestId?: unknown }).requestId ?? '')
      : '';
    response = await fetch(`${config.agents.runnerGatewayUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runner-key': apiKey,
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      body: encoded,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RunnerUnavailableError(
      `agent runner gateway unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new RunnerUnavailableError('agent runner response exceeded the safety limit');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new RunnerUnavailableError(
      `agent runner returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return decoded;
}

function reportUsage(callback: ((usage: AgentUsage) => void) | undefined, usage?: AgentUsage): void {
  if (!callback || !usage) return;
  try { callback(usage); } catch { /* telemetry is never load-bearing */ }
}

export const remoteAgentTransport: AgentExecutionTransport = {
  kind: 'remote',

  async structured<T>(
    runtime: AgentRuntimeId,
    name: string,
    systemPrompt: string,
    userContent: string,
    schema: ZodType<T>,
    options: StructuredOptions,
  ): Promise<T> {
    const requestId = randomUUID();
    const attachments = (options.imagePaths ?? []).map((source, index) => ({
      source: runnerPathRef(source),
      target: `attachments/${String(index).padStart(3, '0')}-${path.basename(source)}`,
    }));
    const request = StructuredExecutionRequestSchema.parse({
      version: RUNNER_PROTOCOL_VERSION,
      operation: 'structured',
      requestId,
      runtime,
      model: options.model,
      claudeCredential: claudeCredential(runtime),
      capacity: capacity(),
      name,
      systemPrompt,
      userContent,
      outputJsonSchema: outputJsonSchema(schema),
      workspace: options.cwd ? runnerPathRef(options.cwd) : undefined,
      buildLog: options.buildLogPath ? runnerPathRef(options.buildLogPath) : undefined,
      attachments,
      options: {
        heavy: options.heavy,
        retries: options.retries,
        kind: options.kind,
        timeoutMs: options.timeoutMs,
        maxTurns: options.maxTurns,
      },
    });
    const raw = await post('/v1/executions', request, (options.timeoutMs ?? 10 * 60_000) + 30_000);
    const response = ExecutionResponseSchema.safeParse(raw);
    if (!response.success || response.data.requestId !== requestId) {
      throw new RunnerUnavailableError('agent runner returned an invalid or mismatched execution response');
    }
    reportUsage(options.onUsage, response.data.usage);
    if (!response.data.ok) throw runnerError(response.data.error);
    const parsed = schema.safeParse(response.data.value);
    if (!parsed.success) {
      throw new AgentSchemaError(
        `remote structured agent "${name}" failed caller schema: ${parsed.error.message.slice(0, 400)}`,
      );
    }
    return parsed.data;
  },

  async code<T>(
    runtime: AgentRuntimeId,
    options: CodeAgentOptions,
    schema: ZodType<T>,
    invocation: CodeAgentInvocationContext,
  ): Promise<T> {
    const request = CodeExecutionRequestSchema.parse({
      version: RUNNER_PROTOCOL_VERSION,
      operation: 'code',
      requestId: invocation.invocationId,
      runtime,
      model: options.model,
      claudeCredential: claudeCredential(runtime),
      capacity: capacity(),
      name: options.name,
      prompt: options.prompt,
      appendSystemPrompt: options.appendSystemPrompt,
      outputJsonSchema: outputJsonSchema(schema),
      workspace: runnerPathRef(options.cwd),
      buildLog: options.buildLogPath ? runnerPathRef(options.buildLogPath) : undefined,
      invocation: { id: invocation.invocationId, notBeforeMs: invocation.notBeforeMs },
      options: {
        maxTurns: options.maxTurns,
        heavy: options.heavy,
        kind: options.kind,
        timeoutMs: options.timeoutMs,
        allowedTools: options.allowedTools,
        skills: options.skills,
        terminal: Boolean(options.terminal),
        terminalWeb: config.build.terminalWeb,
        terminalWritable: config.build.terminalWritable,
        terminalPort: config.build.terminalPort,
      },
    });
    const raw = await post('/v1/executions', request, (options.timeoutMs ?? 60 * 60_000) + 30_000);
    const response = ExecutionResponseSchema.safeParse(raw);
    if (!response.success || response.data.requestId !== invocation.invocationId) {
      throw new RunnerUnavailableError('agent runner returned an invalid or mismatched execution response');
    }
    reportUsage(options.onUsage, response.data.usage);
    if (!response.data.ok) throw runnerError(response.data.error);
    return readAndValidateResult(invocation.resultPath, options.name, schema, invocation);
  },

  async check(provider: AgentCheckProvider): Promise<AgentCheckOutcome> {
    const runtime: AgentRuntimeId = provider === 'claude' ? 'claude-code' : provider;
    const body = AgentCheckRequestSchema.parse({
      version: RUNNER_PROTOCOL_VERSION,
      provider,
      model: effectiveModel(runtime, false, config.agents.modelInputs()),
      claudeCredential: claudeCredential(runtime),
    });
    const raw = await post('/v1/checks', body, 2 * 60_000);
    const response = ControlResponseSchema.safeParse(raw);
    if (!response.success) throw new RunnerUnavailableError('runner returned an invalid check response');
    if (!response.data.ok) throw runnerError(response.data.error);
    return response.data.data as AgentCheckOutcome;
  },

  async account(operation, provider: AgentAccountProvider, code?: string): Promise<AccountControlOutcome> {
    const body = AccountControlRequestSchema.parse({
      version: RUNNER_PROTOCOL_VERSION, operation, provider, code,
    });
    const raw = await post('/v1/accounts', body, 30_000);
    const response = ControlResponseSchema.safeParse(raw);
    if (!response.success) throw new RunnerUnavailableError('runner returned an invalid account response');
    if (!response.data.ok) throw runnerError(response.data.error);
    return response.data.data as AccountControlOutcome;
  },

  async terminal(operation, workspace): Promise<RemoteTerminalInfo | null> {
    const body = TerminalControlRequestSchema.parse({
      version: RUNNER_PROTOCOL_VERSION,
      operation,
      workspace: runnerPathRef(workspace),
    });
    const raw = await post('/v1/terminals', body, 15_000);
    const response = ControlResponseSchema.safeParse(raw);
    if (!response.success) throw new RunnerUnavailableError('runner returned an invalid terminal response');
    if (!response.data.ok) throw runnerError(response.data.error);
    return response.data.data as RemoteTerminalInfo | null;
  },
};
