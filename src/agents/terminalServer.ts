/**
 * ttyd in front of the build's tmux session — the part Roman actually clicks.
 *
 * `tmuxRuntime.ts` puts the agent in a tmux session; that alone is only
 * reachable over SSH. This wraps it in `ttyd`, which serves one terminal over
 * HTTP, so the console can offer «Відкрити термінал збірки» and he sees the
 * real TUI in a browser tab.
 *
 * Design, and why each part is the way it is:
 *
 *  - **One ttyd per process, not per build.** The build worker runs one agent
 *    session at a time (AGENT_CONCURRENCY_BUILD, and the semaphore in
 *    semaphore.ts), so a second ttyd would have nothing to serve. It is
 *    restarted, pointed at the new session, when the next build starts.
 *
 *  - **Read-only by default.** ttyd is writable only under
 *    `BUILD_TERMINAL_WRITABLE`, and even then it is `tmux attach` proper; with
 *    the flag off the session is attached with `-r`, which tmux enforces
 *    itself. Two layers, because a typo in one of them is otherwise a keyboard
 *    into a running client build.
 *
 *  - **Credentialled.** ttyd's own basic auth (`-c user:pass`), with the
 *    password derived from INTERNAL_API_KEY. An unauthenticated terminal is a
 *    shell on the box for anyone who reaches the port — worse than the WAHA QR,
 *    which at least only costs an account.
 *
 *  - **Never load-bearing.** Every failure here is logged and swallowed: ttyd
 *    missing, port busy, binary too old. A build must not fail because its
 *    spectator seat could not be set up.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

/** The live ttyd, if any. One per process — see the note above. */
let current: { proc: ChildProcess; session: string } | null = null;

/** ttyd's basic-auth user. Fixed: the password is the secret, not the name. */
export const TERMINAL_USER = 'roman';

/**
 * Password for the terminal, derived from INTERNAL_API_KEY.
 *
 * Derived rather than reused verbatim so that reading the terminal password
 * (which is typed into a browser prompt, and browsers remember it) does not
 * hand over the key that authenticates the factory's internal API.
 * Empty INTERNAL_API_KEY yields an empty password, which `startTerminalServer`
 * treats as "refuse to start" — never as "start without auth".
 */
export function terminalPassword(internalKey = config.ui.internalApiKey): string {
  if (!internalKey) return '';
  return createHash('sha256').update(`build-terminal:${internalKey}`).digest('hex').slice(0, 24);
}

/** Is ttyd installed? Decides whether the UI offers a link at all. */
export function ttydAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ttyd', ['--version'], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5_000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * The ttyd argv for a session. Exported so the tests can assert the safety
 * properties (read-only, authenticated) without running a binary.
 */
/**
 * Path prefix ttyd serves under. Fixed at /terminal so the operator needs NO
 * extra hostname: one Dokploy/Traefik domain entry on the SAME host
 * (path /terminal → service agent-runner-executor, port 7681) is enough, and
 * BUILD_TERMINAL_BASE_URL becomes https://<та сама адреса UI>/terminal.
 */
export const TERMINAL_BASE_PATH = '/terminal';

export function ttydArgs(session: string, opts: {
  port: number;
  password: string;
  writable: boolean;
}): string[] {
  const args = [
    '-p', String(opts.port),
    '-b', TERMINAL_BASE_PATH,
    '-c', `${TERMINAL_USER}:${opts.password}`,
    // NOT `-o/--once`, which sounds right and is wrong: it makes ttyd exit on
    // the first disconnect, so closing the tab once during a 90-minute build
    // would kill the terminal for the rest of it. The server's lifetime is tied
    // to the tmux session (see tmuxRuntime.ts), not to whether anyone is looking.
    //
    // Reconnecting must also keep working, so no `--max-clients 1` either: an
    // abandoned websocket can outlive the tab that opened it, and a stale one
    // holding the only slot would lock Roman out of his own build.
    //
    // The title bar in the browser tab says which build is being watched.
    '-t', `titleFixed=${session}`,
    // A terminal is worth nothing without scrollback: this is the whole reason
    // for attaching rather than reading the event feed. tmux keeps its own
    // history too; this is the browser side of it.
    '-t', 'scrollback=10000',
  ];
  if (opts.writable) args.push('--writable');
  // `-r` (read-only) is tmux's own enforcement, applied unless writing is
  // explicitly enabled. Belt and braces with ttyd's default non-writable mode.
  args.push('tmux', 'attach', ...(opts.writable ? [] : ['-r']), '-t', session);
  return args;
}

/**
 * Start serving `session` over HTTP. Idempotent per session; safe to call when
 * ttyd is absent (it simply does not start, and says so once).
 *
 * Returns whether a server is now running for that session.
 */
export async function startTerminalServer(
  session: string,
  opts: { enabled?: boolean; port?: number; writable?: boolean } = {},
): Promise<boolean> {
  if (!(opts.enabled ?? config.build.terminalWeb)) return false;
  if (current?.session === session && current.proc.exitCode === null) return true;

  stopTerminalServer();

  const password = terminalPassword();
  if (!password) {
    log.warn('build terminal not served: INTERNAL_API_KEY is unset, and an unauthenticated terminal is a shell on the box', {
      session,
    });
    return false;
  }
  if (!await ttydAvailable()) {
    log.warn('build terminal not served: ttyd is not installed on this host', { session });
    return false;
  }

  const writable = opts.writable ?? config.build.terminalWritable;
  const port = opts.port ?? config.build.terminalPort;
  const proc = spawn('ttyd', ttydArgs(session, { port, password, writable }), {
    stdio: 'ignore',
    // Detached false: the ttyd must die with the worker, or a restarted worker
    // finds the port taken by a server attached to a session that is long gone.
    detached: false,
  });
  proc.on('error', (err) => {
    log.warn('build terminal failed to start', { session, err: String(err).slice(0, 200) });
    if (current?.proc === proc) current = null;
  });
  proc.on('exit', (code) => {
    if (current?.proc === proc) current = null;
    log.info('build terminal stopped', { session, code });
  });

  current = { proc, session };
  log.info('build terminal serving', {
    session, port, writable,
  });
  if (writable) {
    log.warn('build terminal is WRITABLE: keystrokes reach a running client build with no approval trail', { session });
  }
  return true;
}

/** Stop whatever is being served. Called when a build ends. */
export function stopTerminalServer(): void {
  if (!current) return;
  const { proc, session } = current;
  current = null;
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  log.info('build terminal closed', { session });
}

/** Which session is being served right now, if any. Read by the API endpoint. */
export function servedSession(): string | null {
  return current && current.proc.exitCode === null ? current.session : null;
}
