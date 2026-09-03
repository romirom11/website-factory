/** Production confinement shared by runtime adapters and the runner executor. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { codeAgentEnv } from './sandbox.js';
import { runtimeDomains } from '../runner/egressRegistry.js';

export const CODEX_TOOL_PROFILE = 'factory-tools';
export const CODEX_READ_ONLY_PROFILE = 'factory-read-only';
export const CODEX_PACKAGE_PROFILE = 'factory-package-install';

/**
 * Claude's native tool sandbox gets the package registries from the shared
 * egress registry (the same file Squid/CoreDNS render from) plus loopback for
 * the local preview server. Provider APIs are deliberately absent: tools talk
 * to registries, the coordinator talks to the model.
 */
function approvedToolDomains(): string[] {
  return [
    ...runtimeDomains('package').flatMap((domain) => [domain, `*.${domain}`]),
    'localhost',
    '127.0.0.1',
  ];
}

export function runnerConfinementRequired(): boolean {
  return process.env.RUNNER_REQUIRE_ISOLATION === 'true';
}

function runnerWorkRoot(): string {
  return path.resolve(process.env.RUNNER_WORK_ROOT ?? '/app/runner-work');
}

function runnerCredentialRoot(): string {
  return path.resolve(
    process.env.RUNNER_CREDENTIAL_ROOT ?? path.join(runnerWorkRoot(), '.private', 'credentials'),
  );
}

function codexHome(): string {
  return path.resolve(process.env.CODEX_HOME ?? path.join(runnerWorkRoot(), '.private', 'codex'));
}

/**
 * OpenCode's XDG data root: `<root>/opencode/auth.json` holds provider keys.
 * The executor image pins XDG_DATA_HOME; a runner without it uses its private
 * tree; a developer host uses the CLI's own default so the accounts flow and
 * `opencode auth login` agree on one file.
 */
export function openCodeDataRoot(): string {
  if (process.env.XDG_DATA_HOME) return path.resolve(process.env.XDG_DATA_HOME);
  if (process.env.RUNNER_WORK_ROOT || runnerConfinementRequired()) {
    return path.join(runnerWorkRoot(), '.private', 'provider');
  }
  return path.join(homedir(), '.local', 'share');
}

/**
 * OpenCode 1.18 has permission rules but no OS sandbox of its own, so in
 * production the whole `opencode` process runs inside the Codex exact-root
 * sandbox (`codex sandbox`): the same bubblewrap profile Codex applies to its
 * tools and the startup probe exercises. One profile, two runtimes, no second
 * sandbox implementation.
 *
 * One host prerequisite makes this possible: the Bun runtime behind `opencode`
 * aborts without /proc/self, and a nested procfs mount is refused by the
 * kernel while Docker's masked /proc entries are in place. The executor's
 * compose entry therefore carries `systempaths=unconfined`; with it, the Codex
 * sandbox mounts a private procfs (own PID namespace, no executor process
 * visible), which the startup probe verifies. Outside production the command
 * runs as given.
 */
export function confinedCommand(
  command: string,
  args: string[],
  workspace: string,
  profile: typeof CODEX_TOOL_PROFILE | typeof CODEX_PACKAGE_PROFILE = CODEX_TOOL_PROFILE,
): { command: string; args: string[] } {
  if (!runnerConfinementRequired()) return { command, args };
  return {
    command: process.env.CODEX_BIN ?? 'codex',
    args: ['sandbox', '-P', profile, '-C', path.resolve(workspace), '--', command, ...args],
  };
}

/**
 * Environment that keeps any sandboxed process inside its workspace. The
 * exact-root profile hides the runner root (the executor's XDG_DATA_HOME lives
 * there) and has no /home at all, so HOME and every XDG dir point at a scratch
 * tree under the workspace: pnpm's store controller, OpenCode's session DB and
 * caches all land there, and the real credential roots are never even looked
 * for. Measured 2026-09-03: without this, `pnpm install` inside the package
 * profile dies with ENOENT mkdir '/app/runner-work/.private'.
 */
export function sandboxScratchEnv(workspace: string): Record<string, string> {
  const xdg = path.join(path.resolve(workspace), '.factory-tmp', 'sandbox-home');
  return {
    // The sandbox root has no /home; Bun wants a writable HOME on start.
    HOME: path.join(xdg, 'home'),
    XDG_DATA_HOME: path.join(xdg, 'data'),
    XDG_CONFIG_HOME: path.join(xdg, 'config'),
    XDG_CACHE_HOME: path.join(xdg, 'cache'),
    XDG_STATE_HOME: path.join(xdg, 'state'),
  };
}

/** Native Claude sandbox: tools see one workspace, no auth, no parent /proc. */
export function claudeToolSandbox(workspace: string): SandboxSettings | undefined {
  if (!runnerConfinementRequired()) return undefined;
  const cwd = path.resolve(workspace);
  const packageStore = path.join(runnerWorkRoot(), '.pnpm-store');
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    enableWeakerNestedSandbox: false,
    network: {
      allowedDomains: approvedToolDomains(),
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: [
        runnerWorkRoot(),
        runnerCredentialRoot(),
        codexHome(),
        openCodeDataRoot(),
        '/proc',
      ],
      allowRead: [cwd, packageStore],
      allowWrite: [cwd, packageStore],
    },
    credentials: {
      files: [
        { path: runnerCredentialRoot(), mode: 'deny' },
        { path: codexHome(), mode: 'deny' },
        { path: openCodeDataRoot(), mode: 'deny' },
      ],
      envVars: [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'EXECUTOR_API_KEY',
        'INTERNAL_API_KEY',
        'RUNNER_API_KEY',
        'RUNNER_EXECUTOR_API_KEY',
      ].map((name) => ({ name, mode: 'deny' as const })),
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function profileFilesystem(access: 'read' | 'write', includePackageStore = false): string {
  const work = runnerWorkRoot();
  const packageStore = path.join(work, '.pnpm-store');
  return [
    '":minimal" = "read"',
    // One deny mount for the shared root is sufficient: credentials, sibling
    // invocations and the package cache all live below it. Re-allow only the
    // exact workspace (and, for package commands, the store). Separate nested
    // deny mounts make bubblewrap recreate parents under the container's
    // read-only root and therefore fail before executing the command.
    `${tomlString(work)} = "none"`,
    `":workspace_roots" = "${access}"`,
    ...(includePackageStore ? [`${tomlString(packageStore)} = "write"`] : []),
  ].join('\n');
}

/** Replace persisted user policy with the runner-owned, fail-closed profiles. */
export async function configureCodexConfinement(): Promise<void> {
  if (!runnerConfinementRequired()) return;
  const home = codexHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const config = [
    `default_permissions = ${tomlString(CODEX_TOOL_PROFILE)}`,
    '',
    `[permissions.${CODEX_TOOL_PROFILE}.filesystem]`,
    profileFilesystem('write', true),
    '',
    `[permissions.${CODEX_TOOL_PROFILE}.network]`,
    // Tool subprocesses need loopback for the local preview/screenshot flow.
    // The executor has no default route; its outer internal networks, filtered
    // DNS and allowlist proxy remain the enforceable destination boundary.
    'enabled = true',
    '',
    `[permissions.${CODEX_READ_ONLY_PROFILE}.filesystem]`,
    profileFilesystem('read'),
    '',
    `[permissions.${CODEX_READ_ONLY_PROFILE}.network]`,
    'enabled = false',
    '',
    `[permissions.${CODEX_PACKAGE_PROFILE}.filesystem]`,
    profileFilesystem('write', true),
    '',
    `[permissions.${CODEX_PACKAGE_PROFILE}.network]`,
    'enabled = true',
    '',
    '[shell_environment_policy]',
    'inherit = "all"',
    // Codex filters are case-insensitive globs, not regular expressions.
    // Built-in exclusions cover KEY, TOKEN and SECRET; explicit filters close
    // the remaining common credential names even if this command is invoked
    // without the executor's outer codeAgentEnv scrubber.
    'ignore_default_excludes = false',
    '',
    '[shell_environment_policy.filters]',
    '"*PASSWORD*" = "exclude"',
    '"*CREDENTIAL*" = "exclude"',
    '"*AUTH*" = "exclude"',
    '',
  ].join('\n');
  await writeFile(path.join(home, 'config.toml'), config, { encoding: 'utf8', mode: 0o600 });
}

/** Runtime args selecting exact-root permissions instead of legacy full-read. */
export function codexExecConfinementArgs(
  profile: typeof CODEX_TOOL_PROFILE | typeof CODEX_READ_ONLY_PROFILE,
  developmentSandbox: 'workspace-write' | 'read-only',
): string[] {
  if (!runnerConfinementRequired()) return ['--sandbox', developmentSandbox];
  return [
    '--strict-config',
    '-c', `default_permissions=${tomlString(profile)}`,
    '--ask-for-approval', 'never',
    '--ignore-rules',
  ];
}

interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Run package lifecycle work with workspace-only files and proxy-only egress. */
export async function runConstrainedPackageCommand(
  cwd: string,
  args: string[],
  timeoutMs: number,
  allowNetwork = true,
): Promise<CommandResult> {
  await mkdir(path.join(cwd, '.factory-tmp'), { recursive: true });
  const launch = confinedCommand(
    args[0]!, args.slice(1), cwd, allowNetwork ? CODEX_PACKAGE_PROFILE : CODEX_TOOL_PROFILE,
  );
  const env = {
    ...codeAgentEnv(undefined, cwd),
    ...(runnerConfinementRequired() ? sandboxScratchEnv(cwd) : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > 20_000) output = output.slice(-10_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
