/**
 * Shared contracts for the agent runtime layer.
 *
 * SPEC §2.3 / decision #10: every agent call is billed to a SUBSCRIPTION
 * (Claude Code OAuth, or Codex CLI / ChatGPT). No pay-per-token API path exists
 * anywhere in this layer — there is deliberately no way to pass an API key.
 */
import type { ZodType } from 'zod';

/**
 * The runtime-id union is DEFINED in `modelPolicy.ts` — the one agent-layer
 * module that must stay import-free, because it is copied into the UI image
 * (see ui/Dockerfile) and the UI cannot resolve repo-relative imports.
 * Re-exported here so the rest of the agent layer can use it normally.
 */
import type { AgentRuntimeId } from './modelPolicy.js';
export type { AgentRuntimeId };

/** Human-readable name for console messages, Telegram texts and UI cards. */
export const RUNTIME_LABELS: Record<AgentRuntimeId, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
};

/** Label with a fallback, so an unknown id degrades to words instead of "undefined". */
export function runtimeLabel(id: AgentRuntimeId | undefined): string {
  return (id && RUNTIME_LABELS[id]) || 'агентної моделі';
}

/**
 * What a single agent session actually consumed. Spec §9 wants "QA-ітерації"
 * and "cost per demo" as metrics, so callers can record this per invocation.
 * `costUsd` is the runtime's own estimate of subscription usage, NOT a bill —
 * nothing here is pay-per-token (§2.3).
 */
export interface AgentUsage {
  runtime: AgentRuntimeId;
  model?: string;
  numTurns?: number;
  costUsd?: number;
  durationMs: number;
}

/** Which agent kind is running; retained for routing diagnostics and model-tier call sites. */
export type AgentKind =
  | 'enrichment'
  | 'qa'
  | 'content'
  | 'design'
  | 'outreach'
  | 'builder'
  | 'visual-critique';

export interface StructuredOptions {
  /** Use the heavy model tier (builder / design / QA critique). */
  heavy?: boolean;
  /** Retries on invalid JSON / schema mismatch. Default 2 (=> 3 attempts). */
  retries?: number;
  /** Agent kind, for runtime selection. Defaults to a generic structured call. */
  kind?: AgentKind;
  /** Hard wall-clock cap for a single attempt (ms). Default 10 min. */
  timeoutMs?: number;
  /**
   * Absolute paths of image files the model should look at (visual critique).
   * Delivered by instructing the agent to Read them, so no base64 API payloads.
   */
  imagePaths?: string[];
  /** Working directory for the headless call. Defaults to a scratch dir. */
  cwd?: string;
  /**
   * Turn budget for the headless call. Default 2 with no tools: the answer is
   * normally finished on turn 1, but a large structured output (e.g. 3 full art
   * directions) can need a second turn to finish writing, and `error_max_turns`
   * would otherwise kill a run that was going fine. With `allowedTools: []` the
   * extra turn cannot take any action — it can only complete the answer.
   * Raise it for very large schemas.
   */
  maxTurns?: number;
  /**
   * Called once per completed session with turn/cost telemetry. Optional and
   * never load-bearing: a throwing callback must not fail the agent call.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Absolute path of the project's `build-log.ndjson`. When set, every SDK
   * message worth showing is summarised into it as it streams, so the console
   * can display a live trace of a run that takes an hour. Optional everywhere:
   * an agent that supplies no path produces no trace, and a log that cannot be
   * written never disturbs the run.
   */
  buildLogPath?: string;
  /**
   * Transport-supplied model after the factory resolves live policy. Runner
   * executors have no settings-store access, so they must not resolve it again.
   * Ordinary callers leave this unset.
   */
  model?: string;
  /**
   * Serialized caller-owned schema used only for the model/output-format
   * instruction on a remote executor. The factory still validates the returned
   * value with `schema`; this never weakens the caller's Zod contract.
   */
  outputJsonSchema?: Readonly<Record<string, unknown>>;
  /**
   * @deprecated No effect. Kept so existing call sites compile: the subscription
   * runtimes manage their own output budget, there is no per-request max_tokens.
   */
  maxTokens?: number;
}

export interface CodeAgentOptions {
  name: string;
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  heavy?: boolean;
  kind?: AgentKind;
  /** Hard wall-clock cap for the whole workspace session (ms). Default 60 min. */
  timeoutMs?: number;
  /**
   * Called once per completed session with turn/cost telemetry. Optional and
   * never load-bearing: a throwing callback must not fail the agent call.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Replaces the default workspace tool set
   * (`Bash`,`Read`,`Write`,`Edit`,`Glob`,`Grep`) for calls that need a different
   * one. The social finder passes `['ToolSearch','WebSearch','Read','Write']`:
   * it must reach the network through Anthropic's own search (our server IP is
   * blocked by the engines) but must never run Bash.
   *
   * `ToolSearch` belongs in the list whenever a deferred tool like `WebSearch`
   * is used — the SDK does not hand the agent that schema until it looks it up.
   *
   * The workspace-boundary hook still runs over whatever is listed here.
   */
  allowedTools?: string[];
  /**
   * Skills the workspace session may use, by directory/SKILL.md name, or 'all'.
   * The site builder copies the official GSAP skills into
   * `<workspace>/.claude/skills/` and passes 'all' so the agent can consult them.
   * Omitted = the CLI's own defaults (which is NOT "skills off").
   * Claude Code only; the Codex adapter ignores it.
   */
  skills?: string[] | 'all';
  /**
   * Run this session in a tmux terminal Roman can attach to, instead of the
   * headless SDK. Defaults to `config.build.mode === 'tmux'`.
   *
   * Set `false` for agents nobody would ever watch (the social finder, the brand
   * agent): they are short, they have no workspace worth attaching to, and a
   * tmux session per call would be pure overhead. Supported by both Claude Code
   * and Codex, and ignored on a host with no tmux — see `runCodeAgent()`.
   */
  terminal?: boolean;
  /** Effective terminal settings supplied by the remote factory transport. */
  terminalWeb?: boolean;
  terminalWritable?: boolean;
  terminalPort?: number;
  /**
   * Absolute path of the project's `build-log.ndjson`. When set, the runtime
   * appends a one-line summary of every SDK message as it streams — which is
   * what makes an hour-long build visible in the console instead of a single
   * «Виконується». The builder and the QA critic supply it; agents with no
   * project (brand, social finder) leave it unset and produce no trace.
   *
   * Claude's headless adapter adds typed-message summaries. Codex headless has
   * no equivalent typed stream, but terminal mode exposes its raw CLI output;
   * the worker's own stage markers keep the timeline honest in either mode.
   */
  buildLogPath?: string;
  /** Transport-supplied resolved model; ordinary callers leave this unset. */
  model?: string;
  /**
   * Remote prompt schema. Final validation remains at the factory boundary
   * against the caller's Zod schema after the workspace is synchronized back.
   */
  outputJsonSchema?: Readonly<Record<string, unknown>>;
  /** Runner-internal unique tmux name; factory callers never set this. */
  terminalSession?: string;
}

/**
 * Trusted identity of one workspace-agent invocation.
 *
 * Created only by the public `runCodeAgent()` boundary after it removes the
 * previous result artifact. Adapters receive this immutable lease; callers and
 * transports must not create a second one, otherwise tmux/headless fallback
 * could disagree about which `result.json` belongs to the current run.
 */
export interface CodeAgentInvocationContext {
  readonly invocationId: string;
  readonly workspace: string;
  readonly resultPath: string;
  readonly notBeforeMs: number;
}

/**
 * How a runtime's CLI is launched inside an attachable tmux session.
 * The contract is the same as `codeAgent()`: the prompt reaches the agent and
 * the agent writes `result.json` — only the delivery differs.
 */
export interface TerminalLaunchSpec {
  command: string;
  args: string[];
  /** Claude's TUI needs the prompt typed after first paint; exec-style CLIs do not. */
  needsKickoff: boolean;
  /** Whether browser keystrokes can meaningfully reach the running agent. */
  interactive: boolean;
  /**
   * Regex SOURCE matching this TUI's "input box is listening" state — each CLI
   * paints a different footer (Claude shows its permission mode, OpenCode shows
   * «tab agents»). The tmux runner polls the pane against it before typing the
   * kickoff line; without a pattern it falls back to Claude's.
   */
  kickoffReadyPattern?: string;
  /**
   * Extra environment for the launched CLI beyond the sandbox allowlist and
   * `authEnv()` — per-workspace paths a runtime needs in the terminal path
   * (OpenCode: its generated config and XDG dirs inside the workspace).
   */
  env?: Record<string, string>;
}

/** What `prepareTerminal` receives: call options plus where its settings file goes. */
export type TerminalPrepareOptions = CodeAgentOptions & { settingsPath: string };

/**
 * A runtime adapter is the ONLY thing that knows how to reach a model.
 * Both operations are subscription-authenticated and return validated data.
 *
 * The capability methods below exist so the transports around the adapters
 * (tmux runner, queue, console) never branch on a runtime id. Adding a harness
 * means implementing this interface and registering it in `runtime.ts` —
 * nothing else in the codebase should mention the new id.
 */
export interface AgentRuntime {
  readonly id: AgentRuntimeId;
  /** Human name (RUNTIME_LABELS) for messages people read. */
  readonly label: string;
  /** Headless single-shot, no tools, output validated against `schema`. */
  structured<T>(
    name: string,
    systemPrompt: string,
    userContent: string,
    schema: ZodType<T>,
    opts?: StructuredOptions,
  ): Promise<T>;
  /** Workspace agent with tools; result read from `result.json` and validated. */
  codeAgent<T>(
    opts: CodeAgentOptions,
    resultSchema: ZodType<T>,
    invocation: CodeAgentInvocationContext,
  ): Promise<T>;
  /**
   * Detect an exhausted subscription window in UNSTRUCTURED output — CLI
   * stdout/stderr or tmux scrollback. Returns the RateLimitedError to throw
   * (the job pauses, it does not fail), or null when the text looks normal.
   */
  rateLimitFromText(text: string): RateLimitedError | null;
  /**
   * Launch spec for running this CLI attachably in a tmux session. Must fulfil
   * the same result.json contract as `codeAgent()` in the same workspace.
   */
  terminalLaunch(opts: CodeAgentOptions, context: { settingsPath: string }): TerminalLaunchSpec;
  /**
   * Workspace/host preparation before a terminal launch: guard wiring,
   * first-run trust seeding, permission configs — whatever THIS CLI needs to
   * run unattended with the factory guard in force. Default: nothing to do
   * (a runtime whose launch args alone are enough leaves this undefined).
   */
  prepareTerminal?(opts: TerminalPrepareOptions): Promise<void>;
  /**
   * Subscription credential env vars injected into every agent process beyond
   * the sandbox allowlist (e.g. CLAUDE_CODE_OAUTH_TOKEN). Read PER CALL so a
   * credential pasted in the UI is picked up without a restart. Empty for
   * runtimes whose auth lives on disk in their own home directory.
   */
  authEnv(): Record<string, string>;
}

/**
 * Subscription window exhausted (5-hour or weekly cap), or an upstream 429.
 * SPEC §2.3(б): this is NOT a failure — the job goes to `retry_wait` and the
 * queue re-enqueues it once the window resets. It never counts as an attempt.
 */
export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  readonly retryAfterMs: number;
  readonly rateLimitType?: string;
  readonly resetsAt?: Date;
  /** Runtime whose subscription window was exhausted. */
  readonly runtime: AgentRuntimeId;

  constructor(message: string, opts: {
    retryAfterMs: number;
    rateLimitType?: string;
    resetsAt?: Date;
    runtime: AgentRuntimeId;
  }) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterMs = opts.retryAfterMs;
    this.rateLimitType = opts.rateLimitType;
    this.resetsAt = opts.resetsAt;
    this.runtime = opts.runtime;
  }
}

export function isRateLimitedError(err: unknown): err is RateLimitedError {
  return err instanceof RateLimitedError || (err as { code?: string } | null)?.code === 'RATE_LIMITED';
}

/** The agent produced output that never validated against the schema. */
export class AgentSchemaError extends Error {
  readonly code = 'NEEDS_HUMAN'; // SPEC §7: schema failure -> needs_human, no retry loop
  constructor(message: string) {
    super(message);
    this.name = 'AgentSchemaError';
  }
}

/**
 * The provider rejected the credential (401/403): a key was revoked, expired or
 * never connected. Retrying cannot help and a subscription window is not the
 * cause, so this is NEEDS_HUMAN with a reconnect hint — not RATE_LIMITED.
 */
export class AgentAuthError extends Error {
  readonly code = 'NEEDS_HUMAN';
  constructor(message: string) {
    super(message);
    this.name = 'AgentAuthError';
  }
}

/** Errors that should leave a retry loop immediately and reach a human. */
export function isNeedsHumanError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'NEEDS_HUMAN';
}

/**
 * Remote execution is required but its trusted gateway is unavailable.
 * Worker lifecycle code can park this explicitly; production must never fall
 * back to running an untrusted code agent inside the factory process.
 */
export class RunnerUnavailableError extends Error {
  readonly code = 'RUNNER_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

export function isRunnerUnavailableError(error: unknown): error is RunnerUnavailableError {
  return error instanceof RunnerUnavailableError
    || (error as { code?: string } | null)?.code === 'RUNNER_UNAVAILABLE';
}
