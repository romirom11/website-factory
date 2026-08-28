/** Production confinement shared by runtime adapters and the runner executor. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntimeId } from './types.js';
import { codeAgentEnv } from './sandbox.js';

export const CODEX_TOOL_PROFILE = 'factory-tools';
export const CODEX_READ_ONLY_PROFILE = 'factory-read-only';
export const CODEX_PACKAGE_PROFILE = 'factory-package-install';

const APPROVED_TOOL_DOMAINS = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  '*.yarnpkg.com',
  'localhost',
  '127.0.0.1',
];

export function runnerConfinementRequired(): boolean {
  return process.env.RUNNER_REQUIRE_ISOLATION === 'true';
}

export class RuntimeConfinementError extends Error {
  readonly code = 'NEEDS_HUMAN';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfinementError';
  }
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

function openCodeDataRoot(): string {
  return path.resolve(process.env.XDG_DATA_HOME ?? path.join(runnerWorkRoot(), '.private', 'provider'));
}

/** OpenCode 1.18 has permissions but no OS sandbox/run-as boundary for tools. */
export function assertCodeRuntimeConfined(runtime: AgentRuntimeId): void {
  if (!runnerConfinementRequired() || runtime !== 'opencode') return;
  throw new RuntimeConfinementError(
    'OpenCode tool-enabled execution is disabled: the pinned runtime has no enforceable OS sandbox. ' +
    'Use Claude Code or Codex; tool-free OpenCode structured calls remain available.',
  );
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
      allowedDomains: APPROVED_TOOL_DOMAINS,
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
  const command = runnerConfinementRequired()
    ? ['codex', [
      'sandbox', '-P', allowNetwork ? CODEX_PACKAGE_PROFILE : CODEX_TOOL_PROFILE,
      '-C', cwd, ...args,
    ]] as const
    : [args[0], args.slice(1)] as const;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], {
      cwd,
      env: codeAgentEnv(undefined, cwd),
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
