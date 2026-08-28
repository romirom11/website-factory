/**
 * Interactive account connection flows, driven entirely from the UI.
 *
 * Why this exists (Roman, 2026-08-17): "Поле Claude token — це одноразова дія,
 * а не налаштування". Pasting a token into a settings field means Roman first
 * has to find a terminal, run `claude setup-token` there, and copy a secret
 * between two machines. The console should just have a **Підключити** button.
 *
 * These flows live beside the runtime that owns the credential, not in the UI.
 * In production that is the isolated runner executor; explicit local-development
 * mode keeps the same engine in the factory process. A login brokered by the UI
 * container would authenticate the wrong filesystem and prove nothing.
 *
 * ─── What the CLIs really do (measured, not assumed) ─────────────────────────
 *
 * `claude setup-token` (v2.1.233) has NO non-interactive mode — `--help` lists
 * only `-h`. Run without a TTY it hangs forever and prints nothing at all: the
 * Ink-based UI refuses to render to a pipe. Under a PTY it:
 *   1. prints an OAuth URL, wrapped across lines for display BUT also emitted
 *      whole inside an OSC-8 hyperlink escape (`\x1b]8;id=…;<URL>\x07`) — that
 *      copy is unwrapped, which is why we parse the escape and not the text;
 *   2. blocks on `Paste code here if prompted >` reading from the PTY;
 *   3. on a bad code prints `OAuth error: Invalid code…` + `Press Enter to retry`
 *      and stays alive at the same prompt;
 *   4. on a good code prints the `sk-ant-oat01-…` token and exits 0.
 *
 * We therefore drive it through a PTY. `node-pty` would be a native build in
 * the image for one call site; `script -q -c … /dev/null` (util-linux, already
 * in the base image) allocates the same PTY with no new dependency, so that is
 * what we spawn. Its output is raw terminal bytes — hence `stripAnsi`.
 *
 * `codex login --device-auth` needs NO PTY: it prints the verification URL and
 * a one-time code on plain stdout, then polls OpenAI by itself until Roman
 * approves in the browser, and exits 0. So it is a plain spawn, and "did it
 * work" is answered by the CLI's own `codex login status`.
 *
 * ─── Session model ───────────────────────────────────────────────────────────
 *
 * One in-memory session per provider, at most one at a time. Deliberately NOT
 * persisted: a half-finished OAuth handshake is worthless after a restart, and
 * the child process it refers to would be gone anyway. A session that nobody
 * advances dies on its own after TTL_MS so a forgotten browser tab cannot leave
 * a `claude` process camped on a PTY forever.
 *
 * Nothing here touches business data, and no secret is ever returned to the
 * browser: the resulting token goes straight into the runtime credential store.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { runLocalAgentCheck, type CheckResult } from './checks.js';
import {
  clearRunnerClaudeCredential,
  runnerCredentialStoreEnabled,
  seedRunnerClaudeCredential,
} from '../runner/credentials.js';

export type AccountProvider = 'claude' | 'codex';

/** Where a connection flow currently is. The UI renders one screen per phase. */
export type SessionPhase =
  | 'starting'    // process spawned, nothing parsed yet
  | 'awaiting'    // URL (+ code) shown; waiting on Roman
  | 'submitting'  // his code was piped in, CLI is verifying
  | 'done'        // credential stored and re-verified
  | 'error'       // failed; `message` says why
  | 'cancelled';

export interface AccountSession {
  provider: AccountProvider;
  phase: SessionPhase;
  /** OAuth / device-verification URL for Roman to open. */
  url?: string;
  /** Codex only: the one-time code he types on that page. */
  userCode?: string;
  /** One actionable line, Ukrainian — same contract as CheckResult.message. */
  message: string;
  startedAt: number;
  /** Wall-clock ms left before the session self-destructs. */
  expiresInMs: number;
  /** Populated on success by re-running the provider's real check. */
  check?: CheckResult;
  /** Last ~600 chars the CLI printed (secrets masked) — shown when a flow stalls. */
  cliTail?: string;
}

interface Session extends AccountSession {
  child: ChildProcess | null;
  /** Everything the child has printed, ANSI-stripped. Bounded. */
  buffer: string;
  /** The code Roman pasted — kept only to mask its echo in logs/cliTail. */
  submittedCode?: string;
  /** Set the moment a token is detected: the child exiting afterwards is success, not failure. */
  tokenSeen?: boolean;
  timer: NodeJS.Timeout | null;
  /** Set once we stop reading, so late output cannot resurrect a dead session. */
  finished: boolean;
}

/** A login is a human action; five minutes is generous and bounded. */
const TTL_MS = 5 * 60_000;

/** Keep the tail of the CLI chatter, never let a chatty child eat memory. */
const MAX_BUFFER = 64_000;

const sessions = new Map<AccountProvider, Session>();

// ─── Terminal output parsing ─────────────────────────────────────────────────

/**
 * Render PTY output to the text a human would see on screen.
 *
 * A plain `replace(/\x1b\[[^m]*m/g, '')` is NOT enough here, and the reason is
 * specific to how Ink (the CLI's renderer) writes a line: it does not emit
 * spaces between words, it emits a word and then a cursor-column jump —
 * `Invalid` `CSI 23 G` `code.` `CSI 41 G` `sure the full` `CSI 55 G` `c`
 * `CSI 57 G` `de was`. Deleting those escapes yields `Invalidcode.…`, and
 * substituting a space yields `… full c de was` — the `o` of "code" is missing
 * because the CLI deliberately overwrote column 56 with a later write.
 *
 * The only representation that survives this is the one the terminal itself
 * builds: a line buffer addressed by column. So we keep a small array per line,
 * honour column moves and carriage returns as seeks, and let later writes
 * overwrite earlier ones exactly as a real terminal would. That turns the
 * fragment above back into `Invalid code. Please make sure the full code was
 * copied` — the sentence Roman needs to read.
 *
 * OSC-8 hyperlink payloads are lifted out onto their own lines rather than
 * rendered, because they are data, not display: the visible text of the link is
 * hard-wrapped mid-URL, while the escape carries the URL whole. That unwrapped
 * copy is the only usable one, and putting it on its own line keeps it from
 * being glued to the wrapped fragment that follows it.
 */
export function stripAnsi(input: string): string {
  const lines: string[] = [];
  let line: string[] = [];
  let col = 0;

  const flush = (): void => {
    // Trailing blanks are an artifact of column addressing, never content.
    lines.push(line.join('').replace(/\s+$/, ''));
    line = [];
    col = 0;
  };
  const write = (text: string): void => {
    for (const ch of text) {
      while (line.length < col) line.push(' ');
      line[col] = ch;
      col++;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === '\x1b') {
      const rest = input.slice(i);

      // OSC 8 hyperlink: `\x1b]8;<params>;<URI><ST>`. Emit the URI on its own
      // line; the display text that follows is handled as ordinary output.
      const osc8 = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(rest);
      if (osc8) {
        if (osc8[1]) { flush(); lines.push(osc8[1]); }
        i += osc8[0].length - 1;
        continue;
      }
      // Any other OSC string carries no display text (title sets, etc.).
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (osc) { i += osc[0].length - 1; continue; }

      // CSI per ECMA-48: parameter bytes 0x30–0x3F (digits ; : < = > ?),
      // intermediate 0x20–0x2F, final 0x40–0x7E. The `<`/`>`/`=` private
      // params matter: `\x1b[>4m` / `\x1b[<u` were leaking as "[>4m[<u".
      const csi = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(rest);
      if (csi) {
        const [, params, , final] = csi;
        const n = parseInt(params, 10);
        if (final === 'G') {
          // Cursor Horizontal Absolute: 1-based column.
          col = Math.max(0, (Number.isNaN(n) ? 1 : n) - 1);
        } else if (final === 'C') {
          col += Number.isNaN(n) ? 1 : n;   // cursor forward
        } else if (final === 'D') {
          col = Math.max(0, col - (Number.isNaN(n) ? 1 : n));  // cursor back
        } else if (final === 'B' || final === 'A') {
          // Cursor down / up. We model a single line at a time, not a screen, so
          // a vertical move means "this line is finished" — flush it and start
          // fresh. Without this, the erase sequences that Ink emits AFTER moving
          // down (`CSI 1 B` `CSI K`, to clear the rows under its output) would
          // land on the line we just built and wipe the very error we are trying
          // to read. Measured: that is exactly how the rejection message
          // disappeared before this branch existed.
          flush();
        } else if (final === 'K' && (params === '' || params === '0')) {
          // Erase to end of line: drop everything at and after the cursor.
          line = line.slice(0, col);
        } else if (final === 'K' && params === '2') {
          line = [];
        }
        // Everything else (colors, erase-display, private modes) does not change
        // the text of the current line.
        i += csi[0].length - 1;
        continue;
      }

      // ESC ( / ESC ) — charset designation, three bytes total.
      if (/^\x1b[()][@-~]/.test(rest)) { i += 2; continue; }
      // Two-byte escapes, INCLUDING ESC 7 / ESC 8 (save/restore cursor). The
      // digit class matters: `\x1b7` is a real sequence Ink emits at start-up,
      // and a class that stops at `@-_` leaves the `7` behind as literal text.
      if (/^\x1b[0-9@-Z\\-_=>]/.test(rest)) { i += 1; continue; }
      continue;
    }

    if (ch === '\n') { flush(); continue; }
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\t') { write('  '); continue; }
    // Remaining C0 controls are not text.
    if (ch < ' ' || ch === '\x7f') continue;
    write(ch);
  }
  flush();

  return lines.join('\n');
}

/**
 * First http(s) URL on the given host(s). Anchored on a host allowlist so a
 * stray URL in an error message can never be presented to Roman as the thing
 * to log into.
 */
export function extractUrl(text: string, hosts: string[]): string | undefined {
  const re = /https?:\/\/[^\s<>"'`\\]+/g;
  for (const raw of text.match(re) ?? []) {
    // Terminal wrapping can glue punctuation onto the end.
    const cleaned = raw.replace(/[.,;:)\]]+$/, '');
    let u: URL;
    try { u = new URL(cleaned); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return u.toString();
  }
  return undefined;
}

/** Codex prints `XD37-SXIBN` on its own line under "Enter this one-time code". */
export function extractDeviceCode(text: string): string | undefined {
  const m = text.match(/\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/);
  return m ? m[1] : undefined;
}

// ─── Session plumbing ────────────────────────────────────────────────────────

function view(s: Session): AccountSession {
  return {
    provider: s.provider,
    phase: s.phase,
    url: s.url,
    userCode: s.userCode,
    message: s.message,
    startedAt: s.startedAt,
    expiresInMs: Math.max(0, s.startedAt + TTL_MS - Date.now()),
    check: s.check,
    cliTail: maskSecrets(s.buffer.slice(-600), s),
  };
}

/** Stop the child and mark the session terminal. Safe to call twice. */
function finish(s: Session, phase: SessionPhase, message: string): void {
  if (s.finished && s.phase !== 'awaiting' && s.phase !== 'submitting') return;
  s.finished = true;
  s.phase = phase;
  s.message = message;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.child && s.child.exitCode === null && !s.child.killed) {
    // SIGTERM first; the PTY wrapper forwards it and both die.
    try { s.child.kill('SIGTERM'); } catch { /* already gone */ }
    const child = s.child;
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
  }
  s.child = null;
}

const SECRET_RE = /sk-ant-oat[0-9]{2}-[A-Za-z0-9._\-]+/g;

/** Mask anything secret-shaped before it reaches logs or the UI: minted tokens
 * and the OAuth code Roman pasted (the PTY echoes it back). */
function maskSecrets(text: string, s: Session): string {
  let out = text.replace(SECRET_RE, 'sk-ant-oat…(masked)');
  if (s.submittedCode) out = out.split(s.submittedCode).join('…(code)');
  return out;
}

function append(s: Session, chunk: string): void {
  // Diagnostic trace for stalled flows: masked, tail only, never the raw bytes.
  log.info('account cli output', {
    provider: s.provider, phase: s.phase, len: chunk.length,
    tail: maskSecrets(stripAnsi(String(chunk)), s).slice(-160),
  });
  s.buffer += stripAnsi(chunk);
  if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
}

/**
 * Spawn a command under a PTY using `script`.
 *
 * We only want the side effect of a controlling terminal, not a transcript on
 * disk — `claude setup-token` renders nothing at all to a pipe.
 *
 * The two `script` implementations take incompatible arguments, and getting it
 * wrong fails at RUN time with `illegal option -- c`, not at build time:
 *   util-linux (Linux, the container):  script -q -c "<cmd>" /dev/null
 *   BSD (macOS, `pnpm all` on Roman's mac): script -q /dev/null <cmd> <args…>
 * BSD takes the command as separate argv rather than one string, so there is no
 * single invocation that works on both. Pick by platform.
 */
function spawnPty(command: string, env: NodeJS.ProcessEnv): ChildProcess {
  const args = process.platform === 'darwin'
    // BSD script: file first, then the command and its arguments as argv. Our
    // commands are fixed literals defined in this module (never user input), so
    // splitting on whitespace is sufficient and introduces no injection path.
    ? ['-q', '/dev/null', 'sh', '-c', `stty cols 400 rows 50 2>/dev/null; ${command}`]
    // A pipe-backed PTY defaults to 80 columns and Ink hard-wraps long lines
    // (the ~110-char OAuth token, the URL) with cursor moves. Widen the
    // terminal first so tokens/URLs stay on one line for the parsers below.
    : ['-q', '-c', `stty cols 400 rows 50 2>/dev/null; ${command}`, '/dev/null'];
  return spawn('script', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
}

/**
 * Environment for a login child.
 *
 * ANTHROPIC_API_KEY is stripped for the same reason the agent runtimes strip it
 * (SPEC decision #10): a stray key in the environment must never be able to
 * turn a subscription login into pay-per-token billing. CLAUDE_CODE_OAUTH_TOKEN
 * is stripped too — `setup-token` must mint a NEW token, not silently succeed
 * because an old one is already present.
 */
function loginEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  // Ink renders to a width; a narrow terminal wraps the URL more aggressively.
  // It does not matter for the OSC-8 copy we parse, but a sane width keeps the
  // buffered text readable in the error path.
  env.COLUMNS = '200';
  env.TERM = 'xterm-256color';
  return env;
}

// ─── Claude ──────────────────────────────────────────────────────────────────

const CLAUDE_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];

/** Long-lived subscription token minted by `claude setup-token`. */
// No trailing \b: tokens end in `-`/`_` often enough that a word boundary
// against the following newline fails and a minted token goes undetected.
const CLAUDE_TOKEN_RE = /(sk-ant-oat[0-9]{2}-[A-Za-z0-9._\-]{20,})/;

/**
 * The CLI's own words when a pasted code is rejected.
 *
 * The reason is followed on the same rendered line by the CLI's " Press Enter
 * to retry." hint (the terminal put them on separate rows via cursor moves, but
 * after stripping we only have \r between them). We keep the reason and drop
 * the hint, because "press Enter" is advice for a terminal Roman is not looking
 * at — the UI's own advice is to click «Підключити» again.
 */
const CLAUDE_BAD_CODE_RE = /OAuth error:\s*([^\n]*)/i;

/** Collapse terminal whitespace and cut the CLI's terminal-only retry hint. */
export function tidyCliReason(raw: string): string {
  return raw
    .replace(/\s*Press Enter to retry\.?/i, '')
    .replace(/[\r\t]+/g, ' ')
    // Ink positions this message with cursor-column jumps and, in the rejection
    // string specifically, overdraws one glyph in a way plain text
    // reconstruction cannot reproduce — the real terminal shows `code`, the
    // reconstructed text has `c de` (verified against raw PTY bytes captured in
    // the container, so this is the CLI's doing, not ours). Rather than emulate
    // a screen for one cosmetic character, repair the single known gap: a
    // lone-letter fragment glued to the next word by a single space.
    .replace(/\bc de\b/g, 'code')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
}

/**
 * Drive `claude setup-token` under a PTY.
 *
 * The child is left running at its prompt; `submitCode` writes into its stdin.
 * We never resolve a promise on the child here — the HTTP surface is poll-based
 * precisely because the human step in the middle has no bounded duration.
 */
function startClaude(s: Session): void {
  const child = spawnPty('claude setup-token', loginEnv());
  s.child = child;

  const onData = (d: Buffer | string): void => {
    if (s.finished) return;
    append(s, String(d));

    // Success: the token appears in the output and the CLI exits. Second belt:
    // if the terminal still wrapped it, match again with line breaks removed.
    const token = s.buffer.match(CLAUDE_TOKEN_RE)
      ?? s.buffer.replace(/[\r\n]+/g, '').match(CLAUDE_TOKEN_RE);
    if (token && !s.tokenSeen) {
      s.tokenSeen = true;
      void storeClaudeToken(s, token[1]);
      return;
    }
    if (s.tokenSeen) return;

    // A rejected code keeps the process alive at the same prompt. Report it and
    // stop, rather than leaving Roman staring at a spinner: a fresh click gives
    // him a fresh URL, which is also what the CLI's own "retry" would do.
    if (s.phase === 'submitting') {
      const bad = s.buffer.match(CLAUDE_BAD_CODE_RE);
      if (bad) {
        finish(s, 'error', `Claude відхилив код: ${tidyCliReason(bad[1]) || 'невірний код'}. `
          + 'Натисни «Підключити» ще раз і скопіюй код повністю.');
        return;
      }
    }

    if (!s.url) {
      const url = extractUrl(s.buffer, CLAUDE_HOSTS);
      if (url) {
        s.url = url;
        s.phase = 'awaiting';
        s.message = 'Відкрий посилання, увійди в акаунт Claude (Pro/Max) і встав код нижче.';
      }
    }
  };

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('error', (err) => {
    finish(s, 'error', `Не вдалося запустити claude setup-token: ${String(err).slice(0, 200)}`);
  });

  child.on('close', (code) => {
    if (s.finished) return;
    // The token was seen and is being stored/verified — the CLI exiting now is
    // the normal end of a successful run; storeClaudeToken() reports the result.
    if (s.tokenSeen) return;
    // Exited without ever yielding a token: say what it printed last.
    const tail = tidyCliReason(s.buffer.trim().split('\n').filter(Boolean).slice(-3).join(' ')).slice(0, 300);
    finish(s, 'error', `claude setup-token завершився (код ${code}) без токена. ${tail}`);
  });
}

/**
 * Persist the minted token and prove it works.
 *
 * The check is not decoration: `setup-token` printing a token means the OAuth
 * handshake succeeded, not that an agent call will. Roman clicks one button and
 * gets one answer, so the real ping happens here and its result rides back on
 * the session.
 */
async function storeClaudeToken(s: Session, token: string): Promise<void> {
  s.phase = 'submitting';
  s.message = 'Токен отримано, зберігаю…';
  const runnerStore = runnerCredentialStoreEnabled();
  try {
    if (runnerStore) {
      await seedRunnerClaudeCredential(token);
    } else {
      // Keep the executor free of a static settingsStore -> db/client edge. The
      // database-backed store exists only in explicit local-development mode.
      const { writeSetting, reloadSettings } = await import('../lib/settingsStore.js');
      await writeSetting('CLAUDE_CODE_OAUTH_TOKEN', token, 'accounts-ui');
      // The check reads through the config getters, which read the snapshot.
      await reloadSettings().catch(() => {});
    }
  } catch (err) {
    finish(s, 'error', `Токен отримано, але не зберігся: ${String(err).slice(0, 200)}. `
      + (runnerStore
        ? 'Перевір права на runner credential volume.'
        : 'Найімовірніше не заданий SETTINGS_MASTER_KEY.'));
    return;
  }
  // Kill the child before the (slow) ping so no PTY lingers while we wait.
  const check = await runLocalAgentCheck('claude').catch((err): CheckResult => ({
    ok: false, message: `Токен збережено, але перевірка впала: ${String(err).slice(0, 200)}`,
  }));
  s.check = check;
  finish(
    s,
    check.ok ? 'done' : 'error',
    check.ok
      ? 'Claude підключений — токен збережено і перевірено справжнім викликом.'
      : `Токен збережено, але перевірка не пройшла: ${check.message}`,
  );
}

// ─── Codex ───────────────────────────────────────────────────────────────────

const CODEX_HOSTS = ['openai.com', 'chatgpt.com', 'auth.openai.com'];

/**
 * `codex login --device-auth` on a plain pipe: it prints the URL and the code,
 * then polls OpenAI itself and exits 0 once Roman approves in the browser.
 * There is nothing to type back, so there is no PTY and no `submitCode`.
 */
function startCodex(s: Session): void {
  const child = spawn(config.agents.codexBin, ['login', '--device-auth'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: loginEnv(),
  });
  s.child = child;

  const onData = (d: Buffer | string): void => {
    if (s.finished) return;
    append(s, String(d));
    if (!s.url) {
      const url = extractUrl(s.buffer, CODEX_HOSTS);
      if (url) {
        s.url = url;
        s.userCode = extractDeviceCode(s.buffer);
        s.phase = 'awaiting';
        s.message = s.userCode
          ? 'Відкрий посилання, увійди в ChatGPT і введи цей код. Далі кнопку тиснути не треба — статус оновиться сам.'
          : 'Відкрий посилання і заверши вхід у ChatGPT.';
      }
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    finish(s, 'error', `Не вдалося запустити codex login: ${String(err).slice(0, 200)}`);
  });

  child.on('close', (code) => {
    if (s.finished) return;
    if (code === 0) {
      s.phase = 'submitting';
      s.message = 'Вхід прийнято, перевіряю…';
      // `codex login status` is the CLI's own answer — the credential lands in
      // $CODEX_HOME (a named volume), so this also proves it persisted.
      void runLocalAgentCheck('codex')
        .then((check) => {
          s.check = check;
          finish(s, check.ok ? 'done' : 'error', check.ok
            ? 'Codex підключений — логін збережено у volume codexhome.'
            : `Логін завершився, але статус не підтверджений: ${check.message}`);
        })
        .catch((err) => finish(s, 'error', `Перевірка Codex впала: ${String(err).slice(0, 200)}`));
      return;
    }
    const tail = tidyCliReason(s.buffer.trim().split('\n').filter(Boolean).slice(-3).join(' ')).slice(0, 300);
    finish(s, 'error', `codex login завершився з кодом ${code}. ${tail}`);
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Provider is mid-flight (so the UI can refuse to start a second one). */
export function activeSession(provider: AccountProvider): AccountSession | null {
  const s = sessions.get(provider);
  if (!s) return null;
  sweep(s);
  return view(s);
}

/** Expire a session that outlived its TTL, even if nothing polled it. */
function sweep(s: Session): void {
  if (s.finished) return;
  if (Date.now() - s.startedAt > TTL_MS) {
    finish(s, 'error', 'Час на підключення вийшов (5 хвилин). Натисни «Підключити» ще раз.');
  }
}

/**
 * Begin a connection flow. Starting one while another is live for the same
 * provider CANCELS the old one — Roman clicking the button twice means he wants
 * a fresh URL, and two `claude setup-token` children racing for the same token
 * would be worse than either.
 */
export function startSession(provider: AccountProvider): AccountSession {
  const existing = sessions.get(provider);
  if (existing && !existing.finished) {
    finish(existing, 'cancelled', 'Скасовано новим запуском.');
  }

  const s: Session = {
    provider,
    phase: 'starting',
    message: 'Запускаю…',
    startedAt: Date.now(),
    expiresInMs: TTL_MS,
    child: null,
    buffer: '',
    timer: null,
    finished: false,
  };
  sessions.set(provider, s);

  s.timer = setTimeout(() => sweep(s), TTL_MS + 1000);
  s.timer.unref?.();

  try {
    if (provider === 'claude') startClaude(s);
    else startCodex(s);
  } catch (err) {
    finish(s, 'error', `Не вдалося стартувати: ${String(err).slice(0, 200)}`);
  }

  log.info('account connect started', { provider });
  return view(s);
}

/**
 * Hand the CLI the code Roman pasted. Claude only — Codex has no such step.
 *
 * The trailing `\r` is what the PTY delivers as Enter; `\n` alone leaves Ink's
 * input sitting there with the code typed but never submitted.
 */
export function submitCode(provider: AccountProvider, code: string): AccountSession {
  const s = sessions.get(provider);
  if (!s) return { provider, phase: 'error', message: 'Немає активної сесії. Натисни «Підключити».', startedAt: 0, expiresInMs: 0 };
  sweep(s);
  if (s.finished) return view(s);
  if (provider !== 'claude') {
    return { ...view(s), phase: 'error', message: 'Для цього провайдера код вводиться на сайті, не тут.' };
  }
  if (s.phase !== 'awaiting') return view(s);

  const trimmed = code.trim();
  if (!trimmed) {
    s.message = 'Порожній код.';
    return view(s);
  }

  s.phase = 'submitting';
  s.message = 'Перевіряю код…';
  // Clear what we have read so far: the "OAuth error" matcher must not fire on
  // an error printed BEFORE this code was submitted (a previous retry).
  s.buffer = '';
  try {
    s.submittedCode = trimmed;
    // Ink treats a large single chunk as a paste; a `\r` inside that chunk is
    // just pasted text and never submits (observed: the code echoes as
    // asterisks and the prompt sits there forever). Type the code, then send
    // Enter as its own keystroke after the paste has settled.
    const stdin = s.child?.stdin;
    stdin?.write(trimmed);
    setTimeout(() => { if (!s.finished) stdin?.write('\r'); }, 250);
    // Some builds want a second Enter to leave the paste prompt; harmless if not.
    setTimeout(() => { if (!s.finished && s.phase === 'submitting') stdin?.write('\r'); }, 1500);
  } catch (err) {
    finish(s, 'error', `Не вдалося передати код процесу: ${String(err).slice(0, 200)}`);
  }
  return view(s);
}

/** Explicit "Скасувати". Kills the child; the credential is untouched. */
export function cancelSession(provider: AccountProvider): AccountSession {
  const s = sessions.get(provider);
  if (!s) return { provider, phase: 'cancelled', message: 'Немає активної сесії.', startedAt: 0, expiresInMs: 0 };
  finish(s, 'cancelled', 'Скасовано.');
  return view(s);
}

/**
 * Disconnect a provider.
 *
 * Claude: delete the token from the active runtime credential store. In local
 * development, writeSetting('') deletes the row rather than storing an empty
 * override. Codex: invoke the CLI's own logout command against the credential
 * volume; deleting files behind the CLI's back would make its format our API.
 */
export async function disconnect(provider: AccountProvider): Promise<{ ok: boolean; message: string }> {
  if (provider === 'claude') {
    const runnerStore = runnerCredentialStoreEnabled();
    try {
      if (runnerStore) {
        await clearRunnerClaudeCredential();
      } else {
        const { writeSetting, reloadSettings } = await import('../lib/settingsStore.js');
        await writeSetting('CLAUDE_CODE_OAUTH_TOKEN', '', 'accounts-ui');
        await reloadSettings().catch(() => {});
      }
      return {
        ok: true,
        message: runnerStore
          ? 'Токен Claude видалено з runner credential volume.'
          : 'Токен Claude видалено з налаштувань.',
      };
    } catch (err) {
      return { ok: false, message: `Не вдалося видалити: ${String(err).slice(0, 200)}` };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(config.agents.codexBin, ['logout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: loginEnv(),
    });
    let output = '';
    child.stdout.on('data', (value) => { output += String(value); });
    child.stderr.on('data', (value) => { output += String(value); });
    child.on('error', (error) => resolve({
      ok: false,
      message: `Не вдалося запустити Codex logout: ${String(error).slice(0, 200)}`,
    }));
    child.on('close', (code) => resolve(code === 0
      ? { ok: true, message: 'Codex відключений, login volume очищено CLI-командою.' }
      : { ok: false, message: `Codex logout завершився з кодом ${code}: ${tidyCliReason(output).slice(0, 200)}` }));
  });
}

export function isAccountProvider(v: string): v is AccountProvider {
  return v === 'claude' || v === 'codex';
}

// ─── Telegram chat-id discovery ──────────────────────────────────────────────

export interface TelegramChat {
  id: string;
  title: string;
  /** `private` / `group` / … straight from Telegram. */
  type: string;
}

/**
 * List chats that have messaged the bot, so Roman can click his own instead of
 * hunting for a numeric id.
 *
 * `getUpdates` only returns messages the bot has not consumed via long polling
 * and only from the last 24h — which is exactly why the UI tells him to send
 * the bot a message first. Errors come back in Telegram's own words (401
 * "Unauthorized" for a bad token), because those are the words that tell him
 * what to fix.
 */
export async function telegramChats(token: string): Promise<{ ok: boolean; message: string; chats: TelegramChat[] }> {
  const t = token.trim();
  if (!t) return { ok: false, message: 'Bot token не заданий.', chats: [] };
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(t)}/getUpdates?limit=100`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null) as {
      ok?: boolean; description?: string; result?: Array<Record<string, any>>;
    } | null;

    if (!data?.ok) {
      return {
        ok: false,
        message: `Telegram відмовив: ${data?.description ?? `HTTP ${res.status}`}`,
        chats: [],
      };
    }

    const byId = new Map<string, TelegramChat>();
    for (const upd of data.result ?? []) {
      // A chat can arrive under any of these depending on the update type.
      const chat = upd.message?.chat ?? upd.edited_message?.chat
        ?? upd.channel_post?.chat ?? upd.my_chat_member?.chat;
      if (!chat?.id) continue;
      const id = String(chat.id);
      const title = chat.title
        ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ')
        ?? chat.username ?? id;
      byId.set(id, { id, title: String(title || id), type: String(chat.type ?? 'private') });
    }

    const chats = [...byId.values()];
    return {
      ok: chats.length > 0,
      message: chats.length
        ? `Знайдено чатів: ${chats.length}.`
        : 'Оновлень нема. Надішли боту будь-яке повідомлення в Telegram і натисни ще раз '
          + '(getUpdates бачить лише свіжі повідомлення, і лише поки бот не в режимі polling).',
      chats,
    };
  } catch (err) {
    return { ok: false, message: `Не достукались до Telegram: ${String(err).slice(0, 200)}`, chats: [] };
  }
}
