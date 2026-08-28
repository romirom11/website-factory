/**
 * OpenCode runtime adapter — subscription harness #3.
 *
 * Auth lives in OpenCode's own home (`~/.local/share/opencode/auth.json`,
 * managed by `opencode auth login`), so like Codex this adapter injects
 * NO credentials into agent processes (`authEnv()` is empty). Nothing
 * pay-per-token: whatever provider Roman logged in to bills its own
 * subscription; no API key is ever read or passed by the factory.
 *
 * Transport is `opencode run --format json`: NDJSON events on stdout
 * (step_start / tool_use / text / step_finish / error). Verified live against
 * 1.18.x on 2026-08-24:
 *
 *   {"type":"text","part":{"type":"text","text":"…"}}
 *   {"type":"tool_use","part":{"type":"tool","tool":"write","state":{...}}}
 *   {"type":"step_finish","part":{"reason":"stop"|"tool-calls","tokens":{…},"cost":0}}
 *   {"type":"error","error":{"name":"APIError","data":{"statusCode":402,…}}}
 *
 * Two headless permission behaviours were measured, and both matter here:
 *   - an "ask" WITHOUT --auto is AUTO-REJECTED (fail-closed, never hangs) and a
 *     human-readable line lands in stdout between the JSON events;
 *   - with --auto, asks are approved but explicit "deny" rules still hold.
 * So codeAgent() runs --auto under a generated deny-config (the workspace
 * guard below), while structured() runs without --auto behind a config that
 * denies every tool outright — the equivalent of Claude's allowedTools: [].
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { outputJsonSchema, extractJson, jsonOnlyInstruction } from './schema.js';
import { withAgentSlot } from './semaphore.js';
import { codeAgentEnv } from './sandbox.js';
import { withStructuredRetries } from './retry.js';
import { looksRateLimited, rateLimitedFromText } from './ratelimit.js';
import { effectiveModel } from './modelPolicy.js';
import { readAndValidateResult } from './result.js';
import { appendBuildLog, clip, type BuildLogEvent } from '../build/buildLog.js';
import {
  RateLimitedError,
  RUNTIME_LABELS,
  type AgentRuntime,
  type CodeAgentInvocationContext,
  type AgentUsage,
  type CodeAgentOptions,
  type StructuredOptions,
  type TerminalLaunchSpec,
} from './types.js';

const DEFAULT_STRUCTURED_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CODE_TIMEOUT_MS = 60 * 60_000;

/** Subscription/credit walls seen in the wild, beyond the shared text signatures. */
const OPENCODE_LIMIT_STATUS = new Set([401, 402, 429]);
const OPENCODE_LIMIT_TEXT = [/payment required/i, /membership benefits/i, /insufficient credits?/i];

function opencodeLooksLimited(text: string): boolean {
  return OPENCODE_LIMIT_TEXT.some((re) => re.test(text)) || looksRateLimited(text);
}

// ─── Event stream parsing (pure, unit-tested against captured fixtures) ──────

export interface OpencodeEvent {
  type: 'step_start' | 'tool_use' | 'text' | 'step_finish' | 'error' | string;
  timestamp?: number;
  sessionID?: string;
  part?: Record<string, any>;
  error?: { name?: string; data?: { message?: string; statusCode?: number } };
}

/**
 * Parse stdout into events, tolerating the human-readable lines the CLI
 * interleaves ("! permission requested: … auto-rejecting"). A line that does
 * not parse as JSON is skipped, never fatal.
 */
export function parseOpencodeEvents(stdout: string): OpencodeEvent[] {
  const events: OpencodeEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed) as OpencodeEvent); } catch { /* noise line */ }
  }
  return events;
}

/** The model's final answer is the LAST text event of the run. */
export function lastTextEvent(events: OpencodeEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.part?.text;
    if (typeof t === 'string' && t.trim()) return t;
  }
  return '';
}

/** All assistant prose concatenated — what a person would want to read after a failure. */
export function allText(events: OpencodeEvent[]): string {
  return events.filter((e) => e.type === 'text').map((e) => e.part?.text ?? '').join('\n');
}

/** Telemetry for §9: every step is a turn; cost/tokens accumulate over steps. */
export function usageFromEvents(events: OpencodeEvent[]): Pick<AgentUsage, 'numTurns' | 'costUsd'> {
  let numTurns = 0;
  let costUsd = 0;
  let sawCost = false;
  for (const e of events) {
    if (e.type !== 'step_finish') continue;
    numTurns++;
    const c = e.part?.cost;
    if (typeof c === 'number') { costUsd += c; sawCost = true; }
  }
  return { numTurns, costUsd: sawCost ? costUsd : undefined };
}

/**
 * Classify a finished run's events. Returns RateLimitedError when the
 * subscription window / membership is exhausted (job pauses, SPEC §2.3б),
 * a plain Error for any other terminal error event, null when clean.
 */
export function errorFromEvents(events: OpencodeEvent[]): Error | null {
  const err = events.find((e) => e.type === 'error')?.error;
  if (!err) return null;
  const message = String(err.data?.message ?? err.name ?? 'unknown error');
  const blob = `${message} ${JSON.stringify(err.data ?? {})}`;
  if (
    (err.data?.statusCode !== undefined && OPENCODE_LIMIT_STATUS.has(err.data.statusCode)) ||
    opencodeLooksLimited(blob)
  ) {
    return rateLimitedFromText('opencode', blob.slice(-300));
  }
  return new Error(`opencode run failed: ${clip(message, 300)}`);
}

/** One build-log line per event worth showing — same shapes as summarizeSdkMessage. */
export function summarizeOpencodeEvent(e: OpencodeEvent, agent?: string): BuildLogEvent | null {
  const t = new Date().toISOString();

  if (e.type === 'error') {
    const message = String(e.error?.data?.message ?? e.error?.name ?? 'error');
    return { t, type: 'error', agent, summary: clip(message, 120) };
  }

  if (e.type === 'tool_use') {
    const p = e.part ?? {};
    const input = (p.state?.input ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    let detail = '';
    switch (String(p.tool)) {
      case 'write':
      case 'edit':
      case 'read':
        detail = shortPath(str(input.filePath) || str(input.path));
        break;
      case 'bash':
        detail = clip(str(input.command), 120);
        break;
      case 'glob':
      case 'grep':
        detail = clip(str(input.pattern), 120);
        break;
      case 'webfetch':
        detail = clip(str(input.url), 120);
        break;
      default:
        detail = '';
    }
    const failed = p.state?.status === 'error';
    return {
      t, type: failed ? 'result' : 'tool', tool: String(p.tool ?? 'tool'),
      status: failed ? 'error' : undefined,
      summary: failed ? `${detail || 'failed'} — відхилено дозволом`.trim() : detail,
      agent,
    };
  }

  if (e.type === 'text') {
    const text = typeof e.part?.text === 'string' ? e.part.text.trim() : '';
    if (!text) return null;
    return { t, type: 'text', summary: clip(text, 300), agent };
  }

  // step_start and step_finish are pacing, not story.
  return null;
}

/** Workspace-relative path for readable log lines (same rule as buildLog.shortPath). */
function shortPath(p: string): string {
  if (!p) return '';
  const marker = `${path.sep}sites${path.sep}`;
  const idx = p.indexOf(marker);
  if (idx >= 0) {
    const rest = p.slice(idx + marker.length).split(path.sep).slice(2).join('/');
    if (rest) return rest;
  }
  return p.split(path.sep).slice(-2).join('/');
}

// ─── The workspace guard as an OpenCode config file ──────────────────────────

/**
 * Deny-rules that hold even under `--auto` (explicit denies always win).
 * Mirrors the intent of the Claude PreToolUse guard's most important lines;
 * the real boundary stays the container, this is the second belt.
 *
 * Rules are pattern-based, LAST match wins — so the `.env.example` allow must
 * come after the `.env` deny. webfetch is denied outright for the same measured
 * reason as Claude's WebFetch: it runs from OUR egress and is both blocked and
 * an SSRF foot-gun; fetching belongs to capture.ts.
 */
export function openCodeGuardConfig(): Record<string, unknown> {
  const sensitiveReads = [
    '**/.ssh/**', '**/.aws/**', '**/.gnupg/**', '**/.kube/**', '**/.docker/**',
    '**/.claude/**', '**/.codex/**', '**/.config/opencode/**',
    '**/.netrc', '**/.npmrc', '**/.pgpass',
  ];
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      webfetch: 'deny',
      read: {
        '*': 'allow',
        ...Object.fromEntries(sensitiveReads.map((p) => [p, 'deny'])),
        '**/.env': 'deny',
        '**/.env.*': 'deny',
        '**/.env.example': 'allow',
      },
      edit: {
        '*': 'allow',
        ...Object.fromEntries(sensitiveReads.map((p) => [p, 'deny'])),
        '**/.env': 'deny',
        '**/.env.*': 'deny',
      },
      bash: {
        '*': 'allow',
        'curl*': 'deny', 'wget*': 'deny', 'nc*': 'deny', 'ncat*': 'deny',
        'netcat*': 'deny', 'ssh*': 'deny', 'scp*': 'deny', 'rsync*': 'deny',
        'sftp*': 'deny', 'telnet*': 'deny', 'ftp*': 'deny',
      },
    },
  };
}

/** Every tool denied outright — structured() has nothing to do but answer.
 * The scalar form ("permission": "deny") switches off ALL tools, which is this
 * harness's equivalent of Claude's allowedTools: []. */
function structuredLockConfig(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: 'deny',
  };
}

// ─── Process plumbing ─────────────────────────────────────────────────────────

interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runOpencode(
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Same allowlist as the other adapters; OpenCode reads its credentials from
    // its own HOME, which the allowlist already carries.
    const env = { ...codeAgentEnv(), ...extraEnv };

    const child = spawn(config.agents.openCodeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

interface RunOutcome {
  events: OpencodeEvent[];
  res: ExecResult;
}

async function runAndCollect(
  args: string[],
  cwd: string,
  timeoutMs: number,
  guardConfig: Record<string, unknown>,
  trace?: { logPath?: string; agent?: string },
): Promise<RunOutcome> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'factory-opencode-'));
  const configPath = path.join(scratch, 'guard.json');
  await writeFile(configPath, JSON.stringify(guardConfig, null, 2), 'utf8');
  try {
    const res = await runOpencode(args, cwd, timeoutMs, {
      // Per-run permissions, injected OUTSIDE the workspace: the workspace is a
      // copy of site-template that gets deployed, so factory-internal files
      // have no business living there.
      OPENCODE_CONFIG: configPath,
    });
    const events = parseOpencodeEvents(res.stdout);
    if (trace?.logPath) {
      for (const e of events) {
        const entry = summarizeOpencodeEvent(e, trace.agent);
        if (entry) void appendBuildLog(trace.logPath, entry);
      }
    }
    return { events, res };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Throw RateLimitedError when the stream/output says the window is exhausted. */
function assertNotRateLimited(outcome: RunOutcome, rawTail: string, label: string): void {
  const limited = errorFromEvents(outcome.events);
  if (limited instanceof RateLimitedError) throw limited;
  if (outcome.res.timedOut) {
    throw new Error(`opencode call "${label}" timed out`);
  }
  if (opencodeLooksLimited(rawTail)) {
    throw rateLimitedFromText('opencode', rawTail.slice(-300));
  }
}

// ─── The adapter ──────────────────────────────────────────────────────────────

export const opencodeRuntime: AgentRuntime = {
  id: 'opencode',
  label: RUNTIME_LABELS['opencode'],

  rateLimitFromText(text: string): RateLimitedError | null {
    return opencodeLooksLimited(text) ? rateLimitedFromText(this.id, text) : null;
  },

  /** Credentials stay in OpenCode's own home directory; nothing to inject. */
  authEnv(): Record<string, string> {
    return {};
  },

  terminalLaunch(opts: CodeAgentOptions, _context: { settingsPath: string }): TerminalLaunchSpec {
    const args = [];
    const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());
    if (model) args.push('--model', model);
    args.unshift('--pure');
    return {
      command: config.agents.openCodeBin,
      args,
      needsKickoff: true,
      interactive: true,
      // The TUI's footer paints "tab agents  ctrl+p commands" once the input
      // box accepts keys (captured live, CLI 1.18.x).
      kickoffReadyPattern: 'tab agents|ctrl\\+p commands',
    };
  },

  async structured<T>(
    name: string,
    systemPrompt: string,
    userContent: string,
    schema: ZodType<T>,
    opts: StructuredOptions = {},
  ): Promise<T> {
    const retries = opts.retries ?? 2;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS;
    const prompt = `${systemPrompt}\n\n---\n\n${userContent}${jsonOnlyInstruction(schema, opts.outputJsonSchema)}`;
    const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());

    return withStructuredRetries({
      name, runtime: this.id, retries,
      attempt: (attempt) => withAgentSlot(`structured:${name}`, async () => {
        const attemptStart = Date.now();
        // --pure = no external plugins/MCP servers: the operator's personal
        // ~/.config/opencode must not reach into a factory agent call, exactly
        // like Claude's settingSources: [] in structured().
        const args = ['run', '--pure', '--format', 'json'];
        if (model) args.push('--model', model);
        // Images ride along as attachments the model receives directly — no
        // Read-tool dance needed here (no tools are allowed anyway).
        for (const p of opts.imagePaths ?? []) args.push('--file', p);
        args.push(prompt);

        // No --auto on purpose: any ask would be auto-REJECTED, and the lock
        // config denies every tool outright — this call may only answer.
        const { events, res } = await runAndCollect(
          args, opts.cwd ?? await mkdtemp(path.join(tmpdir(), 'factory-opencode-')),
          timeoutMs, structuredLockConfig(),
          { logPath: opts.buildLogPath, agent: name },
        );
        if (res.timedOut) {
          throw new Error(`opencode structured call "${name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        assertNotRateLimited({ events, res }, `${res.stdout}\n${res.stderr}`.slice(-600), name);

        const limitedErr = errorFromEvents(events);
        if (limitedErr && !(limitedErr instanceof RateLimitedError)) throw limitedErr;

        const candidate = extractJson(lastTextEvent(events));
        if (candidate === undefined) {
          throw new Error(
            `agent "${name}" returned no parseable JSON: ${allText(events).slice(0, 300)}`,
          );
        }
        const parsed = schema.safeParse(candidate);
        if (!parsed.success) {
          throw new Error(`schema validation failed: ${parsed.error.message.slice(0, 500)}`);
        }

        const usage = usageFromEvents(events);
        reportUsage(opts.onUsage, events, model, attemptStart);
        log.info('agent done', { name, runtime: this.id, attempt, turns: usage.numTurns });
        return parsed.data;
      }),
    });
  },

  async codeAgent<T>(
    opts: CodeAgentOptions,
    resultSchema: ZodType<T>,
    invocation: CodeAgentInvocationContext,
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;
    const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());
    const startedAt = Date.now();

    return withAgentSlot(`code:${opts.name}`, async () => {
      const prompt =
        `${opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n---\n\n` : ''}${opts.prompt}\n\n` +
        `MANDATORY FINAL STEP: write a file named result.json in the workspace root (${opts.cwd}) ` +
        `matching this JSON Schema, then stop:\n${JSON.stringify(outputJsonSchema(resultSchema, opts.outputJsonSchema), null, 2)}`;

      // --pure keeps the operator's personal plugins/MCP servers out of a
      // client build (the workspace agent's analogue of settingSources:
      // ['project'] — workspace-local config still applies).
      const args = ['run', '--pure', '--format', 'json', '--auto', '--dir', opts.cwd];
      if (model) args.push('--model', model);
      args.push(prompt);

      const outcome = await runAndCollect(
        args, opts.cwd, timeoutMs, openCodeGuardConfig(),
        { logPath: opts.buildLogPath, agent: opts.name },
      );

      assertNotRateLimited(outcome, `${outcome.res.stdout}\n${outcome.res.stderr}`.slice(-600), opts.name);

      // The current invocation's artifact is the contract: salvage it before
      // declaring failure, exactly like Claude treats error_max_turns sessions.
      if (outcome.res.code !== 0 || outcome.events.some((e) => e.type === 'error')) {
        const salvaged = await readAndValidateResult(
          invocation.resultPath, opts.name, resultSchema, invocation,
        ).catch(() => undefined);
        if (salvaged !== undefined) {
          log.warn('code agent wrote a valid result.json despite a failed run', {
            name: opts.name, exit: outcome.res.code,
          });
          reportUsage(opts.onUsage, outcome.events, model, startedAt);
          return salvaged;
        }
        const other = errorFromEvents(outcome.events);
        const detail = other?.message
          ?? (outcome.res.stderr.slice(-400) || allText(outcome.events).slice(-400));
        throw new Error(
          `opencode code agent "${opts.name}" exited ${outcome.res.code}: ${clip(detail, 400)}`,
        );
      }

      const result = await readAndValidateResult(
        invocation.resultPath, opts.name, resultSchema, invocation,
      );
      reportUsage(opts.onUsage, outcome.events, model, startedAt);
      return result;
    });
  },
};

function reportUsage(
  onUsage: ((u: AgentUsage) => void) | undefined,
  events: OpencodeEvent[],
  model: string,
  startedAt: number,
): void {
  if (!onUsage) return;
  try {
    const u = usageFromEvents(events);
    onUsage({
      runtime: 'opencode', model: model || undefined,
      numTurns: u.numTurns, costUsd: u.costUsd,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    log.warn('onUsage callback threw', { err: String(err).slice(0, 200) });
  }
}
