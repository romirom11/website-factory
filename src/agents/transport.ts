/**
 * Transport-neutral agent execution contract.
 *
 * Factory callers own prompts, Zod schemas and invocation leases. A transport
 * only decides where execution happens. This keeps remote execution from
 * becoming a second agent API with subtly different validation semantics.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import type {
  AgentRuntimeId,
  CodeAgentInvocationContext,
  CodeAgentOptions,
  StructuredOptions,
} from './types.js';
import type {
  AgentAccountProvider,
  AgentCheckProvider,
  RunnerPathRef,
} from '../runner/protocol.js';

export interface AgentCheckOutcome {
  ok: boolean;
  message: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface AccountControlOutcome {
  ok: boolean;
  session?: unknown;
  message?: string;
  /** OpenCode status: catalog providers enabled by OPENCODE_PROVIDERS and whether each holds a key. */
  providers?: Array<{ id: string; name: string; connected: boolean }>;
}

export type AccountOperation = 'start' | 'status' | 'submit-code' | 'cancel' | 'connect' | 'disconnect';
/** OpenCode-only payload: which catalog provider and (for connect) its key. */
export interface AccountProviderInput { providerId?: string; secret?: string }

export interface RemoteTerminalInfo {
  session: string;
  served: boolean;
  writable?: boolean;
  startedAt: string;
  heartbeatAt: string;
  user?: string | null;
  password?: string | null;
}

export interface AgentExecutionTransport {
  readonly kind: 'remote';
  structured<T>(
    runtime: AgentRuntimeId,
    name: string,
    systemPrompt: string,
    userContent: string,
    schema: ZodType<T>,
    options: StructuredOptions,
  ): Promise<T>;
  code<T>(
    runtime: AgentRuntimeId,
    options: CodeAgentOptions,
    schema: ZodType<T>,
    invocation: CodeAgentInvocationContext,
  ): Promise<T>;
  check(provider: AgentCheckProvider): Promise<AgentCheckOutcome>;
  account(
    operation: AccountOperation,
    provider: AgentAccountProvider,
    code?: string,
    input?: AccountProviderInput,
  ): Promise<AccountControlOutcome>;
  terminal(
    operation: 'status' | 'cancel',
    workspace: string,
  ): Promise<RemoteTerminalInfo | null>;
}

export function usesRemoteAgentTransport(): boolean {
  return config.agents.executionMode === 'remote';
}

/** Shared scratch root for small factory-created code/image workspaces. */
export function agentInputsRoot(): string {
  return path.resolve(config.agents.runnerInputsRoot);
}

/** Unlike os.tmpdir(), this directory is visible to the runner gateway. */
export async function createAgentInputWorkspace(prefix: string): Promise<string> {
  const root = agentInputsRoot();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
}

function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** Convert a local path to the only two roots the gateway is allowed to read. */
export function runnerPathRef(candidate: string): RunnerPathRef {
  const sites = relativeInside(config.agents.runnerSitesRoot, candidate);
  if (sites) return { root: 'sites', path: sites };
  const inputs = relativeInside(config.agents.runnerInputsRoot, candidate);
  if (inputs) return { root: 'inputs', path: inputs };
  throw new Error(
    `agent path is outside runner roots: ${path.resolve(candidate)} `
    + `(sites=${path.resolve(config.agents.runnerSitesRoot)}, inputs=${path.resolve(config.agents.runnerInputsRoot)})`,
  );
}
