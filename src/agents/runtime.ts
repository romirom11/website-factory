/**
 * Runtime selection + the public agent API used by every worker.
 *
 * SPEC §2.3 / decision #10: only subscription-authenticated runtimes exist —
 * `claude-code` (Claude Pro/Max via OAuth), `codex` (ChatGPT subscription) and
 * `opencode` (whatever provider is logged into OpenCode). There is no API-key
 * runtime, by construction.
 *
 * ── Adding a harness (the whole checklist) ───────────────────────────────────
 *
 *  1. Implement `AgentRuntime` in a new adapter file. Shared mechanics already
 *     exist: result validation (`result.ts`), rate-limit signatures
 *     (`ratelimit.ts`), the structured retry loop (`retry.ts`), model policy
 *     (`modelPolicy.ts`), env allowlist (`sandbox.ts`).
 *  2. Register it in RUNTIMES below and add its id to `AgentRuntimeId`
 *     + RUNTIME_LABELS (`types.ts`).
 *  3. Extend the AGENT_RUNTIME select options (`src/lib/settings.ts`) and
 *     normalizeRuntime (`src/config.ts`).
 *
 * Nothing else branches on a runtime id: the tmux transport, the queue, the
 * checks and the console all go through the interface's capability methods.
 *
 * Selection: the single `AGENT_RUNTIME` value from the settings UI applies to
 * every kind. `config.agents.runtimeFor(kind)` keeps the kind argument only so
 * callers retain a typed, inspectable routing point.
 */
import { z, type ZodType } from 'zod';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { claudeCodeRuntime } from './claudeCodeRuntime.js';
import { codexRuntime } from './codexRuntime.js';
import { opencodeRuntime } from './opencodeRuntime.js';
import {
  associateInvocationWithError,
  prepareCodeAgentInvocation,
} from './result.js';
import type {
  AgentKind,
  AgentRuntime,
  AgentRuntimeId,
  CodeAgentOptions,
  StructuredOptions,
} from './types.js';

/** Every harness that exists. Selection happens only through config.agents.runtimeFor(). */
const RUNTIMES: Record<AgentRuntimeId, AgentRuntime> = {
  'claude-code': claudeCodeRuntime,
  'codex': codexRuntime,
  'opencode': opencodeRuntime,
};

export function getRuntime(kind?: AgentKind): AgentRuntime {
  return RUNTIMES[config.agents.runtimeFor(kind)];
}

/** A specific runtime by id, for paths that address one explicitly (account
 * flows, per-provider checks, tests) rather than through the global selection. */
export function getRuntimeById(id: AgentRuntimeId): AgentRuntime {
  return RUNTIMES[id];
}

/**
 * Headless structured call: no tools, output validated against `outputSchema`.
 * Invalid JSON / schema mismatch is retried (`opts.retries`, default 2), then
 * raised as a NEEDS_HUMAN-coded error — never a silent fallback value.
 */
export async function runAgent<T>(
  name: string,
  systemPrompt: string,
  userContent: string,
  outputSchema: ZodType<T>,
  opts: StructuredOptions = {},
): Promise<T> {
  return getRuntime(opts.kind).structured(name, systemPrompt, userContent, outputSchema, opts);
}

/**
 * Workspace agent with tools (Bash/Read/Write/Edit/Glob/Grep). The agent's only
 * channel back into the pipeline is `result.json`, validated against `resultSchema`.
 *
 * Two ways to run one, chosen by `config.build.mode` (SPEC §2.3, Roman's
 * requirement 2026-08-22 — "можливість підключення до термінальної сесії"):
 *
 *   `tmux` (default) — the selected CLI in a detached tmux session, which
 *     `ttyd` serves so the console can attach to the REAL terminal, scrollback
 *     and all. See `tmuxRuntime.ts`.
 *   `sdk` — the selected runtime's headless session. Still the fallback.
 *
 * The choice is **per call**, not global — a caller may pin `terminal: false`
 * for an agent nobody would ever watch (the social finder), and the fallback
 * below keeps a host without tmux building normally rather than failing every
 * job. Both subscription CLIs support the attachable path via their
 * `terminalLaunch()` capability.
 */
export function shouldUseAttachableTerminal(
  opts: Pick<CodeAgentOptions, 'terminal'>,
  mode: 'sdk' | 'tmux',
): boolean {
  return opts.terminal ?? mode === 'tmux';
}

export async function runCodeAgent<T>(
  opts: CodeAgentOptions,
  resultSchema: ZodType<T>,
): Promise<T> {
  // The lease is created BEFORE runtime/transport selection. A tmux fallback
  // therefore cannot accidentally start a second lifecycle or see an old file.
  const invocation = await prepareCodeAgentInvocation(opts.cwd);

  try {
    const runtime = getRuntime(opts.kind ?? 'builder');

    const wantsTerminal = shouldUseAttachableTerminal(opts, config.build.mode);
    if (wantsTerminal) {
      const { runCodeAgentTmux, tmuxAvailable } = await import('./tmuxRuntime.js');
      if (await tmuxAvailable()) {
        return await runCodeAgentTmux(opts, resultSchema, undefined, runtime, invocation);
      }
      // Not an error: a dev box without tmux should still build. Warned rather
      // than silent, because "why can't I attach to the terminal" has exactly one
      // answer and this is it.
      log.warn('tmux is not installed; falling back to the selected headless runtime', {
        agent: opts.name, runtime: runtime.id,
      });
    }

    return await runtime.codeAgent(opts, resultSchema, invocation);
  } catch (error) {
    throw associateInvocationWithError(error, invocation);
  }
}

export { z };
export type { AgentKind, AgentRuntime, AgentRuntimeId, CodeAgentOptions, StructuredOptions } from './types.js';
export { RateLimitedError, isRateLimitedError, AgentSchemaError } from './types.js';
export { agentSlotStats, withAgentSlot } from './semaphore.js';
