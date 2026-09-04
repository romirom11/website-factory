/** Startup/readiness checks for the real executor security boundary. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEX_TOOL_PROFILE,
  configureCodexConfinement,
  runnerConfinementRequired,
} from '../agents/confinement.js';
import { codeAgentEnv } from '../agents/sandbox.js';
import { guardHookPath } from '../agents/claudeCodeRuntime.js';
import { executionPaths, SANDBOX_SOCKET_SAMPLE, UNIX_SOCKET_PATH_MAX } from './workspace.js';
import { confinedCommand, sandboxScratchEnv } from '../agents/confinement.js';
import { redactSensitiveText } from '../lib/redaction.js';
import { enabledOpenCodeProviderIds } from './egressRegistry.js';
import { providerBrokerPort } from './providerBroker.js';

const FORBIDDEN_FACTORY_ENV = /^(DATABASE_URL|S3_|AWS_|SMTP_|IMAP_|TELEGRAM_|WAHA_|WHATSAPP_|POSTGRES_|MINIO_|SETTINGS_MASTER_KEY|UI_SESSION_SECRET)/;
const IPV6_DEFAULT_DESTINATION = '0'.repeat(32);

export interface RunnerIsolationReport {
  required: boolean;
  ready: boolean;
  codeRuntimes: Record<'claude-code' | 'codex' | 'opencode', boolean>;
}

function proxyReachable(timeoutMs = 1_500): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: 'agent-egress-proxy', port: 3128 });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
    socket.once('timeout', () => finish(new Error('runner egress proxy probe timed out')));
  });
}

async function readOptionalKernelRoutes(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function assertNoDefaultRoute(): Promise<void> {
  const [ipv4, ipv6] = await Promise.all([
    readFile('/proc/net/route', 'utf8'),
    readOptionalKernelRoutes('/proc/net/ipv6_route'),
  ]);
  const hasIpv4Default = ipv4.split('\n').slice(1).some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === '00000000' && fields[7] === '00000000';
  });
  const hasIpv6Default = ipv6.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === IPV6_DEFAULT_DESTINATION
      && fields[1] === '00'
      && fields[9] !== 'lo';
  });
  if (hasIpv4Default || hasIpv6Default) {
    throw new Error(
      'executor has a default network route; detach external/default networks from the executor',
    );
  }
}

/** Revalidates dependencies that can disappear after the startup probe passed. */
export async function runnerIsolationLive(report: RunnerIsolationReport): Promise<boolean> {
  if (!report.ready) return false;
  if (!report.required) return true;
  try {
    await assertNoDefaultRoute();
    await lookup('registry.npmjs.org');
    await proxyReachable();
    return true;
  } catch {
    return false;
  }
}

function exec(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: codeAgentEnv(undefined, cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > 4_000) output = output.slice(-2_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: redactSensitiveText(String(error)) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: signal ? `${output}\nterminated by ${signal}` : output });
    });
  });
}

function assertExecutorEnvironment(): void {
  const forbidden = Object.keys(process.env).filter((name) => FORBIDDEN_FACTORY_ENV.test(name));
  if (forbidden.length) {
    throw new Error(`executor received forbidden factory environment keys: ${forbidden.join(', ')}`);
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    const value = process.env[name] ?? '';
    if (!/^http:\/\/agent-egress-proxy:3128\/?$/.test(value)) {
      throw new Error(`${name} must point to the private runner egress proxy`);
    }
  }
  if (process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== '1') {
    throw new Error('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is required');
  }
  // The CLI's shell sandbox binds unix sockets under the workspace TMPDIR and
  // Linux caps that path at 108 bytes; over the cap every Bash call in a
  // session dies with «Sandbox is required but failed to initialize».
  const socket = path.join(
    executionPaths('00000000-0000-4000-8000-000000000000').workspace,
    SANDBOX_SOCKET_SAMPLE,
  );
  if (Buffer.byteLength(socket) > UNIX_SOCKET_PATH_MAX) {
    throw new Error(
      `RUNNER_WORK_ROOT is too deep for the CLI sandbox: the socket path would be ` +
      `${Buffer.byteLength(socket)} bytes (max ${UNIX_SOCKET_PATH_MAX}): ${socket}`,
    );
  }
  // The tmux guard hook is a child process the CLI spawns by path. A missing
  // file is a «non-blocking hook error» to the CLI — and no guard at all.
  if (!existsSync(guardHookPath())) {
    throw new Error(`code-agent guard hook is missing from this image: ${guardHookPath()}`);
  }
  const workRoot = path.resolve(process.env.RUNNER_WORK_ROOT ?? '/app/runner-work');
  const privateRoot = path.join(workRoot, '.private');
  for (const [name, rawPath] of [
    ['RUNNER_CREDENTIAL_ROOT', process.env.RUNNER_CREDENTIAL_ROOT],
    ['CODEX_HOME', process.env.CODEX_HOME],
    ['XDG_DATA_HOME', process.env.XDG_DATA_HOME],
  ] as const) {
    const resolved = path.resolve(rawPath ?? '');
    const relative = path.relative(privateRoot, resolved);
    if (!rawPath || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${name} must be mounted below ${privateRoot}`);
    }
  }
}

function runnerDnsProtectionEnabled(): boolean {
  const value = process.env.RUNNER_DNS_PROTECTION_ENABLED ?? 'true';
  if (value !== 'true' && value !== 'false') {
    throw new Error('RUNNER_DNS_PROTECTION_ENABLED must be true or false');
  }
  return value === 'true';
}

export async function initializeRunnerIsolation(): Promise<RunnerIsolationReport> {
  const required = runnerConfinementRequired();
  if (!required) {
    return {
      required: false,
      ready: true,
      codeRuntimes: { 'claude-code': true, codex: true, opencode: true },
    };
  }
  if (process.platform !== 'linux') throw new Error('production runner isolation requires Linux');
  assertExecutorEnvironment();
  await assertNoDefaultRoute();
  await configureCodexConfinement();
  const dnsProtectionEnabled = runnerDnsProtectionEnabled();
  // A typo here would leave the proxy/DNS containers refusing to start while
  // the executor happily reported healthy; fail on the same value they read.
  enabledOpenCodeProviderIds();
  const brokerPort = providerBrokerPort();

  const workspace = await mkdtemp(path.join(tmpdir(), 'runner-isolation-'));
  try {
    // codeAgentEnv points TMPDIR inside the exact workspace. Codex resolves
    // that path while constructing its synthetic mount registry, so the
    // directory must exist before the sandbox process starts.
    await mkdir(path.join(workspace, '.factory-tmp'));
    const probe = await exec('codex', [
      'sandbox', '-P', CODEX_TOOL_PROFILE, '-C', workspace,
      'sh', '-c',
      [
        'touch .write-probe',
        'test -z "$(printenv EXECUTOR_API_KEY || true)"',
        'test ! -r "$1/auth.json"',
        'test ! -r "$2/claude/oauth-token"',
        'test ! -r "$3/opencode/auth.json"',
        // With a private PID namespace /proc/1 is the sandbox's own init, so
        // "readable" proves nothing; what must hold is that no process
        // environment visible in there carries the executor's secret.
        '! grep -qs EXECUTOR_API_KEY /proc/[0-9]*/environ',
        'getent ahosts registry.npmjs.org >/dev/null',
        dnsProtectionEnabled
          ? '! getent ahosts example.com >/dev/null'
          : 'getent ahosts example.com >/dev/null',
        'curl -fsS -o /dev/null --connect-timeout 5 --max-time 15 https://registry.npmjs.org/-/ping',
        '! curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://example.com 2>/dev/null',
        '! curl --noproxy "*" -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://registry.npmjs.org/-/ping 2>/dev/null',
      ].join(' && '),
      'runner-isolation-probe',
      path.resolve(process.env.CODEX_HOME!),
      path.resolve(process.env.RUNNER_CREDENTIAL_ROOT!),
      path.resolve(process.env.XDG_DATA_HOME!),
    ], workspace);
    if (probe.code !== 0) {
      throw new Error(`Codex exact-root sandbox probe failed: ${probe.output.slice(-500)}`);
    }

    // The OpenCode sandbox (own bubblewrap profile, private procfs): the CLI
    // must start, the credential broker must be reachable over shared
    // loopback, and neither the key file nor any executor process environment
    // may be visible from inside.
    const opencodeEnv = Object.entries(sandboxScratchEnv(workspace))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(' ');
    const opencodeLaunch = confinedCommand('sh', [
      '-c',
      [
        // Same XDG/HOME redirection the adapter applies: the real data root is
        // hidden by the sandbox, so OpenCode must not even try to create it.
        `env ${opencodeEnv} OPENCODE_DISABLE_AUTOUPDATE=1 opencode --version >/dev/null`,
        'test ! -r "$1/opencode/auth.json"',
        'test ! -e "$2"',
        '! grep -qs EXECUTOR_API_KEY /proc/[0-9]*/environ',
        `curl -fsS -o /dev/null --noproxy '*' --connect-timeout 3 --max-time 5 http://127.0.0.1:${brokerPort}/healthz`,
      ].join(' && '),
      'opencode-sandbox-probe',
      path.resolve(process.env.XDG_DATA_HOME!),
      path.resolve(process.env.CODEX_HOME!, 'auth.json'),
    ], workspace);
    const opencodeProbe = await exec(opencodeLaunch.command, opencodeLaunch.args, workspace);
    if (opencodeProbe.code !== 0) {
      throw new Error(`OpenCode sandbox probe failed: ${opencodeProbe.output.slice(-500)}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    required: true,
    ready: true,
    codeRuntimes: { 'claude-code': true, codex: true, opencode: true },
  };
}
