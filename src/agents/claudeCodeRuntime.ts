/**
 * Claude Code runtime adapter — the default agent runtime.
 *
 * Authentication is SUBSCRIPTION-ONLY (SPEC §2.3, decision #10):
 *   - server: `claude setup-token` once -> paste the token into the UI's
 *     /settings page (encrypted in Postgres). `config.agents.oauthToken` is a
 *     GETTER, and `authEnv()` reads it inside the call, so a token pasted while
 *     workers are running is picked up on the next agent call — no restart, no
 *     rebuild (Roman's decision 2026-08-17). `.env` still works as a fallback
 *     for a fresh box.
 *   - local dev: nothing to pass, the CLI's own login is used.
 * ANTHROPIC_API_KEY is actively STRIPPED from the child environment (see
 * sandbox.ts) so a stray key in the shell can never silently move billing onto
 * the pay-per-token API.
 *
 * Everything shared with the other adapters lives in its own module: result
 * validation (`result.ts`), rate-limit signatures (`ratelimit.ts`), the
 * structured retry loop (`retry.ts`), model policy (`modelPolicy.ts`). What
 * remains here is only what is genuinely Claude-specific: the Agent SDK
 * session, its typed rate-limit stream, and this CLI's attachable-terminal
 * requirements (guard via --settings, first-run trust seeding).
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { outputJsonSchema, extractJson, jsonOnlyInstruction } from './schema.js';
import { appendBuildLog, summarizeSdkMessage } from '../build/buildLog.js';
import { withAgentSlot } from './semaphore.js';
import { codeAgentEnv, buildPreToolUseGuard } from './sandbox.js';
import { withStructuredRetries } from './retry.js';
import { looksRateLimited, rateLimitedFromInfo, rateLimitedFromText } from './ratelimit.js';
import { effectiveModel } from './modelPolicy.js';
import { readAndValidateResult } from './result.js';
import { claudeToolSandbox } from './confinement.js';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_STRUCTURED_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CODE_TIMEOUT_MS = 60 * 60_000;

/** The guard hook, run by the CLI as a child process on every tool call. */
const GUARD_HOOK = path.join(HERE, 'guardHook.ts');

interface CollectedRun {
  resultText: string;
  structuredOutput: unknown;
  success: boolean;
  errorSubtype?: string;
  errors: string[];
  numTurns: number;
  costUsd?: number;
  /** A `result` message arrived (even a failing one), so a payload may exist. */
  sawResult: boolean;
  /** Set when the SDK threw *after* a result was already emitted. */
  threwAfterResult?: string;
  /** Last rate-limit event seen; `rejected` means the window is exhausted. */
  rateLimit?: { status: string; resetsAt?: number; rateLimitType?: string };
  assistantErrors: string[];
}

/**
 * Drive a query() to completion, collecting everything we need for both
 * result extraction and rate-limit detection. Aborts on timeout.
 *
 * `trace` is the live-build log: when a path is given, every message that says
 * something a person would want to see is summarised into it as it arrives.
 * This is the ONLY place the SDK stream is observed, so it is the only place
 * such a trace can be produced — and it is strictly fire-and-forget: an
 * unwritable log must never disturb a running build (see `appendBuildLog`).
 */
async function collectRun(
  options: Options,
  prompt: string,
  timeoutMs: number,
  label: string,
  trace?: { logPath?: string; agent?: string },
): Promise<CollectedRun> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const out: CollectedRun = {
    resultText: '', structuredOutput: undefined, success: false,
    errors: [], numTurns: 0, assistantErrors: [], sawResult: false,
  };

  try {
    const q = query({ prompt, options: { ...options, abortController: abort } });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as SDKMessage & Record<string, any>;

      if (trace?.logPath) {
        const event = summarizeSdkMessage(m, trace.agent);
        // Not awaited: the agent stream must not be paced by a disk write, and
        // ordering is preserved anyway because appendFile queues per handle.
        if (event) void appendBuildLog(trace.logPath, event);
      }

      if (m.type === 'rate_limit_event') {
        const info = m.rate_limit_info as CollectedRun['rateLimit'];
        out.rateLimit = info;
        if (info?.status === 'rejected') {
          log.warn('subscription rate limit hit', { label, type: info.rateLimitType, resetsAt: info.resetsAt });
        }
        continue;
      }

      // An assistant turn can carry a typed error (rate_limit / overloaded / auth).
      if (m.type === 'assistant' && typeof m.error === 'string') {
        out.assistantErrors.push(m.error);
        continue;
      }

      if (m.type === 'result') {
        out.sawResult = true;
        out.success = m.subtype === 'success';
        out.numTurns = Number(m.num_turns ?? 0);
        out.resultText = typeof m.result === 'string' ? m.result : '';
        out.structuredOutput = m.structured_output;
        out.costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined;
        if (Array.isArray(m.errors)) out.errors = m.errors.map((e: unknown) => String(e));
        if (!out.success) out.errorSubtype = String(m.subtype);
        log.info('claude-code run finished', {
          label, success: out.success, subtype: m.subtype, turns: out.numTurns,
          costUsd: m.total_cost_usd,
        });
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      throw new Error(`claude-code call "${label}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    rethrowRateLimited(err);
    // The SDK converts a non-zero exit that carried an error result into a thrown
    // "Claude Code returned an error result: ..." (see Query.readMessages). If a
    // `result` message already arrived — e.g. error_max_turns on the turn that
    // finished the answer — we have the payload in hand. Keep it and let the
    // caller decide whether it validates, instead of discarding good output.
    if (out.sawResult) {
      out.threwAfterResult = String((err as Error)?.message ?? err).slice(0, 300);
      log.warn('claude-code threw after emitting a result; salvaging payload', {
        label, subtype: out.errorSubtype, turns: out.numTurns,
      });
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  // Structured signal first, then typed assistant errors, then free text.
  if (out.rateLimit?.status === 'rejected') {
    throw rateLimitedFromInfo('claude-code', out.rateLimit, `subscription window exhausted (${out.rateLimit.rateLimitType ?? 'unknown'})`);
  }
  if (out.assistantErrors.some((e) => e === 'rate_limit' || e === 'overloaded')) {
    throw rateLimitedFromInfo('claude-code', out.rateLimit, `model reported ${out.assistantErrors.join(',')}`);
  }
  if (!out.success) {
    const blob = [out.resultText, ...out.errors].join(' ');
    if (looksRateLimited(blob)) throw rateLimitedFromText('claude-code', blob);
  }
  return out;
}

/** Throw RateLimitedError if the thrown SDK/transport error is a 429-shaped one. */
function rethrowRateLimited(err: unknown): void {
  const status = (err as { status?: number })?.status;
  const text = String((err as { message?: string })?.message ?? err);
  if (status === 429 || looksRateLimited(text)) throw rateLimitedFromText('claude-code', text);
}

/** Telemetry is best-effort: a throwing callback must never fail the agent call. */
function reportUsage(
  onUsage: ((u: AgentUsage) => void) | undefined,
  run: CollectedRun,
  model: string,
  startedAt: number,
): void {
  if (!onUsage) return;
  try {
    onUsage({
      runtime: 'claude-code', model,
      numTurns: run.numTurns, costUsd: run.costUsd,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    log.warn('onUsage callback threw', { err: String(err).slice(0, 200) });
  }
}

// ─── Attachable-terminal requirements of THIS CLI ────────────────────────────

/**
 * Mark a workspace as trusted in the CLI's per-user config (~/.claude.json) —
 * the same flag its interactive trust dialog sets. Without this, a fresh
 * workspace makes the TUI block on «Is this a project you trust?» forever and
 * the kickoff line lands on that dialog: measured — the pane sat on the trust
 * prompt for the whole timeout. Merge-write: the file holds other projects too.
 *
 * Two more first-run blockers are seeded here, because a container's HOME is
 * fresh on every image rebuild and a dev Mac hits each exactly once:
 *  - onboarding (theme picker etc.) blocks the TUI before the input box just
 *    like the trust dialog does;
 *  - `--dangerously-skip-permissions` shows a one-time «Bypass Permissions
 *    mode — Yes, I accept / No, exit» dialog with the cursor ON «No, exit».
 *    The kickoff's Enter therefore EXITED the CLI — the «порожня панель»
 *    failure reproduced in a stock node:22-bookworm container (2026-08-22,
 *    CLI 2.1.239). `bypassPermissionsModeAccepted` is what accepting that
 *    dialog writes; seeding it boots the TUI straight to the input box.
 */
export async function preTrustWorkspace(cwd: string): Promise<void> {
  const home = process.env.HOME;
  if (!home) return;
  const cfgPath = path.join(home, '.claude.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>; } catch { /* fresh file */ }
  if (cfg.hasCompletedOnboarding !== true) {
    cfg.hasCompletedOnboarding = true;
    cfg.lastOnboardingVersion = cfg.lastOnboardingVersion ?? '2.0.0';
  }
  cfg.bypassPermissionsModeAccepted = true;
  const projects = (cfg.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[cwd] = {
    ...(projects[cwd] ?? {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  cfg.projects = projects;
  await writeFile(cfgPath, JSON.stringify(cfg), 'utf8').catch(() => undefined);
}

/**
 * The hook + permission settings this CLI runs under in terminal mode.
 * Exported for the tmux-parity test, which asserts the wiring properties
 * (matcher, command form, space-safe quoting) without launching a session.
 *
 * Written as a file passed to `--settings` rather than into the workspace's own
 * `.claude/settings.json`, for two reasons: the workspace is a copy of
 * site-template that gets deployed, so a factory-internal hook config has no
 * business being in it; and `--settings` takes precedence over project settings,
 * so a template that later grows its own settings file cannot disarm the guard.
 *
 * `matcher: '*'` — every tool call is judged, exactly like the SDK's hook, which
 * registers with no matcher at all.
 */
export function guardSettings(workspace: string, tsxBin: string): unknown {
  return {
    sandbox: claudeToolSandbox(workspace),
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              // `tsx` because the guard is TypeScript alongside the rest of src/.
              // Quoted: workspace paths contain no spaces today, but a hook that
              // breaks on one would fail *open* at the worst moment.
              command: `${JSON.stringify(tsxBin)} ${JSON.stringify(GUARD_HOOK)} ${JSON.stringify(workspace)}`,
              timeout: 20,
            },
          ],
        },
      ],
    },
  };
}

/** Absolute path to the repo's tsx, so the hook runs regardless of PATH. */
function tsxBinary(): string {
  // src/agents -> repo root
  return path.resolve(HERE, '..', '..', 'node_modules', '.bin', 'tsx');
}

export const claudeCodeRuntime: AgentRuntime = {
  id: 'claude-code',
  label: RUNTIME_LABELS['claude-code'],

  rateLimitFromText(text: string): RateLimitedError | null {
    return looksRateLimited(text) ? rateLimitedFromText(this.id, text) : null;
  },

  authEnv(): Record<string, string> {
    // Read per call: a token pasted into /settings applies without a restart.
    return { CLAUDE_CODE_OAUTH_TOKEN: config.agents.oauthToken };
  },

  async prepareTerminal(opts: CodeAgentOptions & { settingsPath: string }): Promise<void> {
    await writeFile(
      opts.settingsPath,
      JSON.stringify(guardSettings(opts.cwd, tsxBinary()), null, 2),
      'utf8',
    );
    // Without this the TUI never reaches its input box (see the docblock).
    await preTrustWorkspace(opts.cwd);
  },

  terminalLaunch(opts: CodeAgentOptions, { settingsPath }: { settingsPath: string }): TerminalLaunchSpec {
    const args = [
      '--dangerously-skip-permissions',
      '--model', opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs()),
      '--settings', settingsPath,
      '--setting-sources', 'project',
      '--name', opts.name,
    ];
    if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools);
    return {
      command: 'claude',
      args,
      needsKickoff: true,
      interactive: true,
      // The permissions footer is what first paint of a ready input box shows.
      kickoffReadyPattern: 'bypass permissions|shift\\+tab to cycle',
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
    const jsonSchema = outputJsonSchema(schema, opts.outputJsonSchema);

    // Images are handed over as file paths the agent reads itself (multimodal
    // Read); this keeps everything inside the subscription runtime.
    const needsRead = (opts.imagePaths?.length ?? 0) > 0;
    const imageBlock = needsRead
      ? `\n\nRead these image files before answering (use the Read tool):\n${opts.imagePaths!.map((p) => `- ${p}`).join('\n')}`
      : '';

    const cwd = opts.cwd ?? await mkdtemp(path.join(tmpdir(), 'factory-agent-'));
    const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());

    return withStructuredRetries({
      name, runtime: this.id, retries,
      attempt: (attempt) => withAgentSlot(`structured:${name}`, async () => {
        const options: Options = {
          cwd,
          model,
          // Turn budget. Default 2 without tools: one turn is normally enough,
          // but a large structured output can need a second turn to finish
          // writing, and error_max_turns would discard an otherwise good run.
          // allowedTools: [] means the extra turn can only complete the answer.
          // With images, add a turn per Read.
          maxTurns: opts.maxTurns
            ?? (needsRead ? 2 + opts.imagePaths!.length + 2 : 2),
          allowedTools: needsRead ? ['Read'] : [],
          disallowedTools: needsRead ? ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'] : undefined,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          settingSources: [],
          ...(needsRead ? {
            hooks: { PreToolUse: [{ hooks: [buildPreToolUseGuard(cwd, name)] }] },
          } : {}),
          sandbox: claudeToolSandbox(cwd),
          outputFormat: { type: 'json_schema', schema: jsonSchema },
          // No tools here, but there is still no reason to expose factory
          // secrets to a model processing scraped third-party text.
          env: codeAgentEnv(this.authEnv(), cwd),
        };

        const prompt = `${userContent}${imageBlock}${jsonOnlyInstruction(schema, opts.outputJsonSchema)}`;
        const startedAt = Date.now();
        const run = await collectRun(options, prompt, timeoutMs, `structured:${name}`, {
          logPath: opts.buildLogPath, agent: name,
        });
        reportUsage(opts.onUsage, run, model, startedAt);

        if (!run.success && run.structuredOutput === undefined && !run.resultText) {
          throw new Error(
            `claude-code structured call "${name}" failed: ${run.errorSubtype ?? 'unknown'} ` +
            `${[run.threwAfterResult, ...run.errors].filter(Boolean).join('; ').slice(0, 300)}`,
          );
        }

        // Native structured output first; fall back to parsing the final text.
        // A run that hit the turn cap but still emitted schema-valid JSON is
        // accepted: the deciding question is whether the payload validates,
        // not which subtype the session ended on.
        const candidate = run.structuredOutput !== undefined && run.structuredOutput !== null
          ? run.structuredOutput
          : extractJson(run.resultText);
        if (candidate === undefined) {
          throw new Error(
            `agent "${name}" returned no parseable JSON (${run.errorSubtype ?? 'success'}): ` +
            run.resultText.slice(0, 300),
          );
        }

        const parsed = schema.safeParse(candidate);
        if (!parsed.success) {
          throw new Error(`schema validation failed: ${parsed.error.message.slice(0, 500)}`);
        }
        if (!run.success) {
          log.warn('agent produced valid output despite a failed session subtype', {
            name, subtype: run.errorSubtype, turns: run.numTurns,
          });
        }
        log.info('agent done', { name, runtime: this.id, model, attempt });
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

    return withAgentSlot(`code:${opts.name}`, async () => {
      const options: Options = {
        cwd: opts.cwd,
        model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Default: the builder's tool set. A caller may substitute its own —
        // the social finder swaps Bash for WebSearch, since it searches rather
        // than builds. The PreToolUse guard below applies either way.
        allowedTools: opts.allowedTools ?? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        maxTurns: opts.maxTurns ?? 80,
        // Workspace boundary enforcement. MUST be a PreToolUse hook: canUseTool
        // is not consulted under bypassPermissions (SDK emits
        // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), verified empirically.
        hooks: { PreToolUse: [{ hooks: [buildPreToolUseGuard(opts.cwd, opts.name)] }] },
        sandbox: claudeToolSandbox(opts.cwd),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt },
        // Deliberate asymmetry with structured(), which pins settingSources: [].
        // The workspace agent NEEDS its own `<cwd>/.claude/` (that is where the
        // GSAP skills live), so project settings are loaded — but only project
        // ones: the factory operator's personal ~/.claude config must not change
        // how a client's demo site gets built. Note the cwd is `sites/<biz>/`,
        // which has no CLAUDE.md of its own, so nothing from the factory root
        // is inherited here.
        settingSources: ['project'],
        // Skills shipped inside the workspace (`<cwd>/.claude/skills/`) are only
        // offered to the model when they are explicitly enabled. The site builder
        // relies on this to hand the agent the official GSAP skills.
        ...(opts.skills ? { skills: opts.skills } : {}),
        // Allowlist only: the builder never needs SMTP/IMAP/Telegram/S3/DB creds,
        // and must not be able to exfiltrate them via `echo $SMTP_PASS`.
        env: codeAgentEnv(this.authEnv(), opts.cwd),
      };

      const prompt =
        `${opts.prompt}\n\n` +
        `MANDATORY FINAL STEP: write a file named result.json in the workspace root (${opts.cwd}) ` +
        `matching this JSON Schema, then stop:\n${JSON.stringify(outputJsonSchema(resultSchema, opts.outputJsonSchema), null, 2)}`;

      const startedAt = Date.now();
      const run = await collectRun(options, prompt, timeoutMs, `code:${opts.name}`, {
        logPath: opts.buildLogPath, agent: opts.name,
      });
      reportUsage(opts.onUsage, run, model, startedAt);

      // A session can end on error_max_turns having ALREADY written a valid
      // result.json. The current invocation's artifact is the contract, so
      // check it before declaring failure — but only trust it if it validates.
      if (!run.success) {
        const salvaged = await readAndValidateResult(
          invocation.resultPath, opts.name, resultSchema, invocation,
        ).catch(() => undefined);
        if (salvaged !== undefined) {
          log.warn('code agent wrote a valid result.json despite a failed session subtype', {
            name: opts.name, subtype: run.errorSubtype, turns: run.numTurns,
          });
          return salvaged;
        }
        throw new Error(
          `code agent "${opts.name}" did not finish successfully (${run.errorSubtype ?? 'unknown'}): ` +
          `${[run.threwAfterResult, run.resultText, ...run.errors].filter(Boolean).join(' ').slice(0, 300)}`,
        );
      }
      return readAndValidateResult(invocation.resultPath, opts.name, resultSchema, invocation);
    });
  },
};
