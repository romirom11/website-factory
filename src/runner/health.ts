/** Startup/readiness checks for the real executor security boundary. */
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEX_TOOL_PROFILE,
  configureCodexConfinement,
  runnerConfinementRequired,
} from '../agents/confinement.js';
import { codeAgentEnv } from '../agents/sandbox.js';
import { redactSensitiveText } from '../lib/redaction.js';

const FORBIDDEN_FACTORY_ENV = /^(DATABASE_URL|S3_|AWS_|SMTP_|IMAP_|TELEGRAM_|WAHA_|WHATSAPP_|POSTGRES_|MINIO_|SETTINGS_MASTER_KEY|UI_SESSION_SECRET)/;

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

/** Revalidates dependencies that can disappear after the startup probe passed. */
export async function runnerIsolationLive(report: RunnerIsolationReport): Promise<boolean> {
  if (!report.ready) return false;
  if (!report.required) return true;
  try {
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
  await configureCodexConfinement();

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
        'test ! -r /proc/1/environ',
        'getent ahosts registry.npmjs.org >/dev/null',
        '! getent ahosts example.com >/dev/null',
        'curl -fsS -o /dev/null --connect-timeout 5 --max-time 15 https://registry.npmjs.org/-/ping',
        '! curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://example.com 2>/dev/null',
        '! curl --noproxy "*" -fsS -o /dev/null --connect-timeout 3 --max-time 5 https://registry.npmjs.org/-/ping 2>/dev/null',
      ].join(' && '),
      'runner-isolation-probe',
      path.resolve(process.env.CODEX_HOME!),
      path.resolve(process.env.RUNNER_CREDENTIAL_ROOT!),
    ], workspace);
    if (probe.code !== 0) {
      throw new Error(`Codex exact-root sandbox probe failed: ${probe.output.slice(-500)}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    required: true,
    ready: true,
    codeRuntimes: { 'claude-code': true, codex: true, opencode: false },
  };
}
