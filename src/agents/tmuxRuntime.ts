/**
 * The selected code-agent CLI inside tmux — the runtime Roman can ATTACH to.
 *
 * Why this exists, in his words: «Я питав про можливість підключення до
 * термінальної сесії». The ndjson build log (src/build/buildLog.ts) answers
 * "чи воно живе", but it is a *summary* — three hundred characters per turn,
 * no scrollback, nothing to type into. Watching a build had to mean the same
 * thing as watching the selected CLI in your own terminal. Claude runs its
 * interactive TUI; Codex streams its non-interactive `codex exec` session.
 *
 * So a build can run one of two ways (`config.build.mode`):
 *   `sdk`  — the selected runtime's headless session.
 *   `tmux` — this file: a detached tmux session running the selected CLI,
 *            which `ttyd` then serves over HTTP so the console can attach.
 *
 * The two are deliberately interchangeable: same `CodeAgentOptions`, same
 * `result.json` contract, same errors, same build-log trace. A caller cannot
 * tell them apart except by which one it asked for, and `runCodeAgent()` falls
 * back to the SDK when tmux is not installed — an operator who never sets
 * anything up still gets working builds.
 *
 * This file is runtime-agnostic by construction. It holds the TRANSPORT (tmux
 * session lifecycle, prompt file, completion polling, scrollback capture);
 * everything CLI-specific — launch argv, guard wiring, first-run seeding,
 * auth env — arrives through the `AgentRuntime` capabilities
 * (`terminalLaunch` / `prepareTerminal` / `authEnv` / `rateLimitFromText`).
 *
 * ── What is genuinely different per runtime, and how it is absorbed ──────────
 *
 * 1. **The prompt.** A builder prompt is multiple KB of Markdown. Passing that
 *    through `tmux send-keys` means shell quoting, newline-triggered submits and
 *    a TUI that starts executing half a prompt. So the prompt is WRITTEN TO A
 *    FILE (`AGENT-PROMPT.md`) and the session is sent one short line telling it
 *    to read that file. Nothing long ever crosses the keyboard boundary.
 *
 * 2. **The guard.** The SDK path passes an in-process PreToolUse closure. A CLI
 *    session can only run a *command* hook, so `guardHook.ts` wraps the same
 *    `evaluateToolCall()` as a stdin/stdout process and Claude Code wires it
 *    through its `prepareTerminal` capability (`--settings`). Same decision
 *    function, same deny payload — see `scripts/test-tmux-agent.ts`, which
 *    asserts the two agree.
 *
 * 3. **Completion.** The SDK resolves a promise; a TUI does not. Completion is
 *    therefore the artifact contract that already existed: `result.json` appears
 *    in the workspace. We poll for it, and separately watch whether the pane is
 *    still changing, so "finished" and "died" are distinguishable.
 *
 * 4. **The scrollback.** The whole point is that a person can read what
 *    happened, including after the fact. Before the session is killed its full
 *    pane history is captured to `terminal.log` next to the build log.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { appendBuildLog, clip } from '../build/buildLog.js';
import { zodToJsonSchema } from './schema.js';
import { withAgentSlot } from './semaphore.js';
import { codeAgentEnv } from './sandbox.js';
import { readAndValidateResult } from './result.js';
import { startTerminalServer, stopTerminalServer } from './terminalServer.js';
import type {
  AgentRuntime,
  CodeAgentInvocationContext,
  CodeAgentOptions,
} from './types.js';

/** Prompt handed to the agent as a file, never as keystrokes. See note 1 above. */
export const PROMPT_FILE = 'AGENT-PROMPT.md';

/**
 * Deliver the kickoff line only once the TUI is really listening.
 * 1. Poll the pane until the input box is on screen — readiness is declared by
 *    THIS runtime's `kickoffReadyPattern` (each CLI paints a different footer);
 *    up to 90s: first paint includes MOTD fetches.
 * 2. Send the literal text, then Enter (two calls — together tmux would parse
 *    parts of the text as key names).
 * 3. VERIFY a distinctive fragment of the line is visible in the pane; if the
 *    renderer swallowed it, resend. Three attempts, then throw loudly — a
 *    silently idle build is the failure mode this exists to kill.
 */
async function sendKickoffVerified(
  session: string,
  line: string,
  env: Record<string, string>,
  readyPattern?: string,
): Promise<void> {
  const ready = new RegExp(readyPattern ?? 'bypass permissions|shift\\+tab to cycle', 'i');
  const pane = async (): Promise<string> =>
    (await exec('tmux', ['capture-pane', '-p', '-t', session], { env })).stdout;

  // The footer paints before the input box accepts keys — give the renderer a
  // beat after first paint. `❯` is NOT a readiness signal: the empty input box
  // shows a `❯ Try "…"` placeholder that also burned us in the running-agent
  // check below. Case-insensitive: the footer says «bypass permissions», the
  // acceptance dialog says «Bypass Permissions», and matching only one of them
  // is how the dialog sat unrecognised for the whole timeout.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // A dead CLI is not going to become ready — the old loop polled the void
    // for 90s and then "diagnosed" an empty panel. remain-on-exit keeps the
    // dead pane's output around, so the error can quote claude's actual last
    // words (a crash, an unknown flag, an OOM kill) instead of guessing.
    const died = await paneDeath(session, env);
    if (died) {
      const last = (await pane().catch(() => ''))
        .split('\n').map((l) => l.trim()).filter(Boolean).slice(-10).join(' | ');
      throw new Error(
        `tmux session ${session}: CLI завершився одразу після старту (${died}). ` +
        `Останній вивід: ${last || '(нічого не встиг надрукувати)'}`,
      );
    }
    const text = await pane();
    // preTrustWorkspace seeds bypassPermissionsModeAccepted so this dialog
    // should never render — but a future CLI may rename the key, and Enter on
    // this dialog EXITS the CLI (the cursor starts on «No, exit»). Accepting it
    // here is strictly safer than the blind Enter below landing on it.
    if (/Yes, I accept/i.test(text)) {
      log.warn('bypass-permissions dialog appeared despite the seeded flag; accepting it', { session });
      await exec('tmux', ['send-keys', '-t', session, '2'], { env });
      await new Promise((r) => setTimeout(r, 1_500));
      continue;
    }
    if (ready.test(text)) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await new Promise((r) => setTimeout(r, 3_000));

  const probe = line.slice(0, 24);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await exec('tmux', ['send-keys', '-t', session, '-l', line], { env });
    // Give the renderer a beat to echo the keystrokes before judging.
    await new Promise((r) => setTimeout(r, 1_500));
    const echoed = (await pane()).includes(probe);
    await exec('tmux', ['send-keys', '-t', session, 'Enter'], { env });
    if (echoed) return;
    log.warn('kickoff line not echoed by the TUI, resending', { session, attempt });
    await new Promise((r) => setTimeout(r, 2_000));
    // If the agent actually started despite the failed echo check, the pane
    // shows the working indicator — do not double-send on top of a running
    // agent. ONLY `esc to interrupt` qualifies: the empty input box has a
    // `Try "…"` placeholder that false-positived here and killed the resend.
    if (/esc to interrupt/.test(await pane())) return;
  }
  // Say what IS on screen — the next blocking dialog we have not met yet
  // should diagnose itself from the error, not require exec-ing into the box.
  const raw = await pane().catch(() => '');
  const tail = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(-8).join(' | ');
  // The two blockers we HAVE met get named, with the action that clears them —
  // this error surfaces on the inbox card, where «подивись у tmux» is not a
  // step Roman should need.
  const hint = /select login method|sign in|log in to continue|api key/i.test(raw)
    ? ' CLI просить логін — токен Claude Code не дійшов або недійсний: перепідключи його в /settings → Акаунти.'
    : /choose the text style|dark mode.*light mode|to get started/i.test(raw)
      ? ' CLI показує первинний майстер налаштування — образ factory-build старий (фікс preTrustWorkspace ще не задеплоєний): онови деплой.'
      : '';
  throw new Error(
    `tmux session ${session}: kickoff line never reached the input box.${hint} On screen: ${tail || '(порожня панель)'}`,
  );
}

export async function preTrustWorkspace(cwd: string): Promise<void> {
  const home = process.env.HOME;
  if (!home) return;
  const cfgPath = path.join(home, '.claude.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>; } catch { /* fresh file */ }
  // First-run onboarding (theme picker etc.) blocks the TUI before the input
  // box exactly like the trust dialog does. A container's HOME is fresh on
  // every image rebuild, so unlike a dev Mac it hits onboarding every time —
  // mark it completed the same way finishing the wizard would.
  if (cfg.hasCompletedOnboarding !== true) {
    cfg.hasCompletedOnboarding = true;
    cfg.lastOnboardingVersion = cfg.lastOnboardingVersion ?? '2.0.0';
  }
  // The third first-run blocker, and the nastiest: `--dangerously-skip-permissions`
  // shows a one-time «Bypass Permissions mode — Yes, I accept / No, exit» dialog
  // with the cursor ON «No, exit». The kickoff's Enter therefore EXITED the CLI,
  // which is exactly the «порожня панель» failure reproduced in a stock
  // node:22-bookworm container (2026-08-22, CLI 2.1.239): the session died and
  // every later capture-pane came back empty. This key is what accepting the
  // dialog writes; seeding it boots the TUI straight to the input box.
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
/** Hook + permission config for this session; written per run, never committed. */
const SETTINGS_FILE = '.factory-agent-settings.json';
/** Where the pane scrollback is preserved once the session ends. */
export const TERMINAL_LOG = 'terminal.log';
/**
 * Marker announcing "a terminal for this project is live right now".
 *
 * It exists because the two things that need to agree live in DIFFERENT
 * CONTAINERS: tmux runs in `factory-build`, while the API that answers the UI
 * runs in `factory`, and `tmux has-session` in the latter would always say no.
 * The transport is the one they already share — the `sitesdata` volume — which
 * is exactly how `build-log.ndjson` crosses the same boundary.
 *
 * Written when the session starts, deleted when it ends, including on failure.
 * A stale marker (host killed mid-build) is handled by the reader, which treats
 * one older than STALE_MARKER_MS as gone rather than trusting it forever.
 */
export const TERMINAL_MARKER = 'terminal-session.json';

/** After this long with no refresh, a marker is a leftover, not a live session. */
export const STALE_MARKER_MS = 2 * 60_000;

export interface TerminalMarker {
  session: string;
  /** Whether a web terminal is actually being served, or it is SSH-only. */
  served: boolean;
  /** Effective value for this session; Codex exec is always spectator-only. */
  writable?: boolean;
  startedAt: string;
  /** Refreshed each poll tick; how the reader tells live from leftover. */
  heartbeatAt: string;
}

/** How often `result.json` is checked for. Cheap: one `stat` per tick. */
const POLL_MS = 3_000;
/**
 * A pane whose content has not changed for this long, with no `result.json`,
 * is a session that stopped working — the CLI exited, crashed, or is sitting at
 * a prompt waiting for input nobody is going to type. Generous, because
 * `pnpm install` and `pnpm build` legitimately print nothing for minutes.
 */
const IDLE_GIVEUP_MS = 15 * 60_000;
/** Grace after `result.json` appears, so a partially-written file is not read. */
const RESULT_SETTLE_MS = 1_500;

export interface TmuxSessionInfo {
  session: string;
  workspace: string;
}

/** tmux session name for a project. Also the handle the terminal endpoint uses. */
export function sessionName(projectId: number | string): string {
  return `build-${projectId}`;
}

/** Run a command, capturing stdout. Never throws; the exit code is the answer. */
function exec(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}` });
    });
  });
}

/** Is tmux usable on this host? The one question that decides sdk-vs-tmux. */
export async function tmuxAvailable(): Promise<boolean> {
  const res = await exec('tmux', ['-V'], { timeoutMs: 5_000 });
  return res.code === 0;
}

/** Does this session exist right now? Drives the UI's «термінал живий» state. */
export async function hasSession(session: string): Promise<boolean> {
  const res = await exec('tmux', ['has-session', '-t', session], { timeoutMs: 5_000 });
  return res.code === 0;
}

/**
 * Has the CLI inside the session exited? Sessions run with `remain-on-exit on`,
 * so a dead claude leaves a capturable pane behind instead of vanishing with
 * its last words. Returns a human fragment («сесії вже немає», «код виходу 1»)
 * or null while the process is alive.
 */
async function paneDeath(session: string, env: Record<string, string>): Promise<string | null> {
  if (!await hasSession(session)) return 'сесії вже немає';
  const res = await exec(
    'tmux', ['display-message', '-p', '-t', session, '#{pane_dead} #{pane_dead_status}'],
    { env, timeoutMs: 5_000 },
  );
  const [dead, status] = res.stdout.trim().split(/\s+/);
  if (dead !== '1') return null;
  return status === undefined || status === '' ? 'процес завершився' : `код виходу ${status}`;
}

/** Full pane scrollback (`-S -` = from the very start of the history). */
async function capturePane(session: string): Promise<string> {
  const res = await exec('tmux', ['capture-pane', '-p', '-S', '-', '-t', session], { timeoutMs: 20_000 });
  return res.code === 0 ? res.stdout : '';
}

/** Just the visible pane, for the idle check — capturing full history each tick is wasteful. */
async function captureVisible(session: string): Promise<string> {
  const res = await exec('tmux', ['capture-pane', '-p', '-t', session], { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout : '';
}

async function killSession(session: string): Promise<void> {
  await exec('tmux', ['kill-session', '-t', session], { timeoutMs: 10_000 });
}

/**
 * The one line typed into the session.
 *
 * Short by design (see note 1): everything substantial is in the prompt file.
 * ASCII ONLY. The line travels through `tmux send-keys` under the stripped
 * agent env; without a locale the client mangles multibyte input and the TUI
 * silently drops it — measured: a Ukrainian kickoff never reached the input
 * box while an ASCII probe landed fine. The prompt file itself is UTF-8 and
 * unaffected (it is read from disk, not typed).
 */
export function kickoffLine(promptFile: string): string {
  return `Read ${promptFile} in the workspace root and do everything it says.`;
}

export interface TmuxRunOutcome {
  /** `result` — result.json appeared. `idle`/`timeout`/`gone` — it did not. */
  reason: 'result' | 'idle' | 'timeout' | 'gone';
  scrollback: string;
  elapsedMs: number;
}

/**
 * Map a terminal run with no result artifact to the queue-visible error type.
 *
 * Takes the RUNTIME, not an id: whether a scrollback signals an exhausted
 * subscription window is each CLI's own dialect, so the question goes through
 * `runtime.rateLimitFromText()`. This also covers the Claude TUI now — its
 * pane can print a usage limit just like Codex's output does.
 */
export function terminalFailureError(
  runtime: AgentRuntime,
  outcome: TmuxRunOutcome,
  agentName: string,
): Error {
  const tail = clip(outcome.scrollback.split('\n').slice(-25).join(' '), 400);
  const limited = runtime.rateLimitFromText(outcome.scrollback);
  if (limited) return limited;
  return new Error(
    `tmux code agent "${agentName}" produced no result.json (${outcome.reason} after ` +
    `${Math.round(outcome.elapsedMs / 1000)}s). Pane tail: ${tail}`,
  );
}

/**
 * Wait for the session to produce `result.json`, or to stop being a session
 * that is going to.
 *
 * Three distinct endings, because they need three different messages:
 *   `result`  — the contract was fulfilled.
 *   `gone`    — the tmux session disappeared (claude exited, host restarted).
 *   `idle`    — still alive, but nothing has changed for IDLE_GIVEUP_MS.
 *   `timeout` — the caller's wall-clock budget ran out.
 */
async function waitForResult(
  session: string,
  resultPath: string,
  timeoutMs: number,
  env: Record<string, string>,
  onTick?: () => void,
): Promise<TmuxRunOutcome> {
  const startedAt = Date.now();
  let lastPane = '';
  let lastChangeAt = Date.now();

  for (;;) {
    if (existsSync(resultPath)) {
      // Let the writer finish the file before anyone parses it.
      await new Promise((r) => setTimeout(r, RESULT_SETTLE_MS));
      return { reason: 'result', scrollback: await capturePane(session), elapsedMs: Date.now() - startedAt };
    }

    // With remain-on-exit the session outlives a dead CLI, so «the process
    // exited» is now a dead PANE, not a missing session — and its scrollback
    // is still there to capture, which the old missing-session path never had.
    if (await paneDeath(session, env)) {
      return { reason: 'gone', scrollback: await capturePane(session) || lastPane, elapsedMs: Date.now() - startedAt };
    }

    // Every tick, whether or not the pane moved: the heartbeat says "this
    // process is still watching", which is a different fact from "the agent is
    // still typing" and is the one the UI needs to offer an attach link.
    onTick?.();

    const visible = await captureVisible(session);
    if (visible !== lastPane) {
      lastPane = visible;
      lastChangeAt = Date.now();
    }

    if (Date.now() - lastChangeAt > IDLE_GIVEUP_MS) {
      return { reason: 'idle', scrollback: await capturePane(session), elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt > timeoutMs) {
      return { reason: 'timeout', scrollback: await capturePane(session), elapsedMs: Date.now() - startedAt };
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Run one workspace agent session inside tmux and return its validated result.
 *
 * It fulfils the same artifact contract as an adapter's `codeAgent()`; the
 * additional runtime/session arguments are transport dependencies supplied by
 * `runCodeAgent()`, so the builder itself never branches.
 */
export async function runCodeAgentTmux<T>(
  opts: CodeAgentOptions,
  resultSchema: ZodType<T>,
  /** Session name; defaults to one derived from the workspace. Tests override it. */
  session = sessionName(path.basename(opts.cwd)),
  /** The selected subscription runtime. Its capabilities drive launch, guard and rate-limit handling. */
  runtime: AgentRuntime,
  /** Shared lease created by runCodeAgent() before transport selection. */
  invocation: CodeAgentInvocationContext,
): Promise<T> {
  const resultPath = invocation.resultPath;
  const promptPath = path.join(opts.cwd, PROMPT_FILE);
  const settingsPath = path.join(opts.cwd, SETTINGS_FILE);
  const terminalLogPath = path.join(opts.cwd, TERMINAL_LOG);
  const timeoutMs = opts.timeoutMs ?? 60 * 60_000;

  return withAgentSlot(`tmux:${opts.name}`, async () => {
    await mkdir(opts.cwd, { recursive: true });

    // The prompt file carries the same text the SDK path sends as the prompt,
    // including the mandatory result.json instruction — the contract is
    // identical, only the delivery differs.
    const prompt = `${opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n---\n\n` : ''}${opts.prompt}`;
    await writeFile(
      promptPath,
      `${prompt}\n\n` +
      `MANDATORY FINAL STEP: write a file named result.json in the workspace root (${opts.cwd}) ` +
      `matching this JSON Schema, then stop:\n${JSON.stringify(zodToJsonSchema(resultSchema), null, 2)}\n`,
      'utf8',
    );
    // Per-runtime workspace/host preparation — guard wiring, trust seeding,
    // permission configs. A runtime whose launch args alone are enough leaves
    // this capability undefined and pays nothing.
    await runtime.prepareTerminal?.({ ...opts, settingsPath });

    // A leftover session under the same name would swallow our send-keys and
    // never write a result. Names are per project, so this is a stale one.
    if (await hasSession(session)) {
      log.warn('killing a stale tmux build session before starting', { session });
      await killSession(session);
    }

    const launch = runtime.terminalLaunch(opts, { settingsPath });
    const args = [
      'new-session', '-d', '-s', session, '-c', opts.cwd,
      // Sizing matters: tmux defaults a detached session to 80x24, and the CLI
      // renders its TUI to that width forever after. 200x50 makes the attached
      // view readable instead of a column of wrapped fragments.
      '-x', '200', '-y', '50',
      launch.command,
      ...launch.args,
    ];
    // Chained into the SAME tmux invocation (`;` is tmux's command separator,
    // not the shell's — exec() spawns without a shell): a dying CLI keeps its
    // pane, output and exit status around for `paneDeath` to quote, instead of
    // taking the whole session — and the evidence — down with it. Chained
    // rather than a second exec() so there is no window where an instant crash
    // beats the option.
    args.push(';', 'set-option', '-w', '-t', session, 'remain-on-exit', 'on');

    const env = codeAgentEnv(runtime.authEnv());
    const started = await exec('tmux', args, { env, timeoutMs: 30_000 });
    if (started.code !== 0) {
      throw new Error(
        `tmux could not start the build session: ${clip(`${started.stderr}${started.stdout}`, 300)}`,
      );
    }

    // The spectator seat. Best-effort by construction: a build must not fail
    // because ttyd is missing or its port is busy.
    const writable = config.build.terminalWritable && launch.interactive;
    const served = await startTerminalServer(session, { writable }).catch(() => false);
    const markerPath = path.join(opts.cwd, TERMINAL_MARKER);
    const startedAtIso = new Date().toISOString();
    const writeMarker = async (): Promise<void> => {
      const marker: TerminalMarker = {
        session,
        served,
        writable,
        startedAt: startedAtIso,
        heartbeatAt: new Date().toISOString(),
      };
      await writeFile(markerPath, JSON.stringify(marker), 'utf8').catch(() => undefined);
    };
    await writeMarker();

    await appendBuildLog(opts.buildLogPath, {
      t: new Date().toISOString(), type: 'stage', agent: opts.name,
      summary: served
        ? `Термінальна сесія «${session}» піднята — можна підключитись з картки бізнесу`
        : `Термінальна сесія «${session}» піднята (веб-термінал недоступний, лишається tmux по SSH)`,
    });

    let outcome: TmuxRunOutcome;
    try {
      if (launch.needsKickoff) {
        // Keys sent while the TUI is still painting its welcome screen are
        // silently swallowed, so wait for the input box and verify delivery.
        await sendKickoffVerified(session, kickoffLine(PROMPT_FILE), env, launch.kickoffReadyPattern);
      }

      outcome = await waitForResult(session, resultPath, timeoutMs, env, () => { void writeMarker(); });
    } finally {
      // The marker goes first, in every ending: the UI must stop offering a
      // link to a terminal that is about to stop existing.
      await rm(markerPath, { force: true }).catch(() => undefined);
      // Scrollback is captured BEFORE the session dies, in every ending. This is
      // the record Roman reads afterwards, and it is the only thing that
      // survives the kill below.
      const scrollback = await capturePane(session).catch(() => '');
      if (scrollback) {
        await writeFile(terminalLogPath, scrollback, 'utf8').catch((err) => {
          log.warn('could not write terminal.log', { session, err: String(err).slice(0, 200) });
        });
      }
      // Order matters: ttyd is stopped BEFORE the session is killed, so an
      // attached browser sees the terminal close rather than a dead attach.
      stopTerminalServer();
      await killSession(session).catch(() => undefined);
    }

    if (outcome.scrollback && !existsSync(terminalLogPath)) {
      await writeFile(terminalLogPath, outcome.scrollback, 'utf8').catch(() => undefined);
    }

    if (outcome.reason !== 'result') {
      await appendBuildLog(opts.buildLogPath, {
        t: new Date().toISOString(), type: 'error', agent: opts.name,
        summary: `Термінальна сесія закінчилась без result.json (${outcome.reason})`,
      });
      throw terminalFailureError(runtime, outcome, opts.name);
    }

    await appendBuildLog(opts.buildLogPath, {
      t: new Date().toISOString(), type: 'stage', agent: opts.name,
      summary: `Агент завершив роботу в терміналі за ${Math.round(outcome.elapsedMs / 60_000)} хв`,
    });

    return readAndValidateResult(resultPath, opts.name, resultSchema, invocation);
  });
}

/**
 * Is there a live terminal for this workspace, as seen from ANOTHER process?
 *
 * The API container cannot ask tmux (see `TERMINAL_MARKER`), so it reads the
 * marker off the shared volume. A marker whose heartbeat has stopped is
 * reported as gone: a build worker that was killed mid-session leaves the file
 * behind, and an attach link to a session that no longer exists is worse than
 * no link — it looks like the feature is broken rather than the build.
 */
export async function liveTerminal(workspaceDir: string): Promise<TerminalMarker | null> {
  try {
    const marker = JSON.parse(
      await readFile(path.join(workspaceDir, TERMINAL_MARKER), 'utf8'),
    ) as TerminalMarker;
    const age = Date.now() - new Date(marker.heartbeatAt).getTime();
    if (!Number.isFinite(age) || age > STALE_MARKER_MS) return null;
    return marker;
  } catch {
    return null;
  }
}

/** Read a finished run's scrollback, for the UI's "the session already ended" case. */
export async function readTerminalLog(workspaceDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(workspaceDir, TERMINAL_LOG), 'utf8');
  } catch {
    return null;
  }
}
