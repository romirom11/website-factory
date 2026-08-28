/**
 * Defence-in-depth for the workspace (code) agent.
 *
 * The builder runs with `bypassPermissions` because it must install packages and
 * run builds unattended. That makes two things load-bearing:
 *
 *  1. `codeAgentEnv()` — an explicit ALLOWLIST of environment variables. The
 *     factory process holds SMTP/IMAP credentials, Telegram tokens, S3 keys and
 *     DATABASE_URL; none of them are any of the site builder's business, and a
 *     prompt-injected page in the evidence snapshot must not be able to exfiltrate
 *     them via `echo $SMTP_PASS`.
 *
 *  2. `buildPreToolUseGuard()` — a PreToolUse hook that vets every tool call
 *     against the workspace boundary.
 *
 * IMPORTANT (verified empirically against SDK 0.3.233): `canUseTool` is NOT
 * consulted under `permissionMode: 'bypassPermissions'` — the SDK emits
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED and auto-approves every call. Bare entries in
 * `allowedTools` shadow it even under `permissionMode: 'default'`. A PreToolUse
 * hook DOES fire in both cases and its `deny` is honoured, so the guard is built
 * on hooks. Do not "simplify" this to canUseTool: it would silently do nothing.
 *
 * This is a safety net, not the security boundary. Production isolation is the
 * native runtime sandbox plus the internal Docker/DNS/proxy topology.
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { log } from '../lib/logger.js';

/** Env vars the workspace build genuinely needs. Everything else is dropped. */
const ENV_ALLOWLIST_EXACT = new Set([
  'PATH', 'HOME', 'SHELL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME',
  'LANG', 'PWD', 'SHLVL',
  // package managers / toolchain
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NVM_DIR', 'NVM_BIN', 'NVM_INC',
  'COREPACK_HOME', 'COREPACK_ENABLE_STRICT', 'PNPM_HOME', 'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CI',
  // agent runtime auth (subscription only)
  'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME',
  // self-screenshot (`pnpm shot` in the workspace): playwright-core resolves
  // the shared browser install from this path; without it the agent codes blind.
  'PLAYWRIGHT_BROWSERS_PATH',
  // egress via a corporate proxy, if the host uses one
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);

/** Prefix-matched allowlist (locale + package-manager knobs). */
const ENV_ALLOWLIST_PREFIXES = ['LC_', 'NPM_CONFIG_', 'npm_config_', 'PNPM_', 'COREPACK_'];

/**
 * Secrets that must never reach the builder even if someone adds them to the
 * allowlist by mistake. Belt and braces: the allowlist already excludes them.
 */
const ENV_DENYLIST_PREFIXES = [
  'SMTP_', 'IMAP_', 'TELEGRAM_', 'WAHA_', 'WHATSAPP_', 'S3_', 'AWS_', 'DATABASE_',
  'POSTGRES_', 'UI_', 'DOKPLOY_', 'GOSOM_', 'ANTHROPIC_', 'OPENAI_',
];

function isDenied(name: string): boolean {
  return ENV_DENYLIST_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Environment for a CODE agent process: allowlisted parent env plus whatever
 * subscription credentials the selected runtime injects via its
 * `authEnv()` capability (Claude's OAuth token; Codex/OpenCode keep theirs on
 * disk and inject nothing).
 * @param injected per-runtime credentials, added verbatim on top of the allowlist.
 */
export function codeAgentEnv(
  injected?: Record<string, string>,
  workspace?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || isDenied(k)) continue;
    const allowed = ENV_ALLOWLIST_EXACT.has(k) || ENV_ALLOWLIST_PREFIXES.some((p) => k.startsWith(p));
    if (allowed) env[k] = v;
  }
  // Never inherited beyond what the runtime explicitly provides; only
  // subscription credentials are ever injected here.
  for (const [k, v] of Object.entries(injected ?? {})) {
    if (v) env[k] = v;
  }
  // A UTF-8 locale must always exist: without one, tmux send-keys mangles
  // multibyte input on its way into the agent TUI (measured), and tools inside
  // the workspace read/write UTF-8 files. Containers often ship with no LANG.
  if (!env.LANG) env.LANG = 'C.UTF-8';
  // Native/runtime sandboxes isolate tool processes from the credential-bearing
  // coordinator. Claude additionally creates a private PID namespace so Bash
  // cannot scrape the parent's environment through /proc.
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DO_NOT_TRACK = '1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  if (workspace) {
    env.TMPDIR = path.join(path.resolve(workspace), '.factory-tmp');
  }
  return env;
}

/** Sensitive paths that are off-limits regardless of where the workspace is. */
const SENSITIVE_PATH_FRAGMENTS = [
  '/.ssh', '/.aws', '/.config', '/.gnupg', '/.kube', '/.docker',
  '/.netrc', '/.npmrc', '/.pgpass', '/.claude', '/.codex',
  '/etc/passwd', '/etc/shadow',
];

/** Commands that reach the network. Denied unless clearly a package-manager op. */
const NETWORK_COMMANDS = ['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'rsync', 'sftp', 'telnet', 'ftp'];

/** Package-manager / toolchain commands whose own network access is expected. */
const PACKAGE_COMMANDS = ['pnpm', 'npm', 'npx', 'yarn', 'node', 'corepack', 'next', 'tsc', 'vite', 'esbuild'];

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

/** Resolve a path against the workspace, following symlinks where they exist. */
function resolveWithin(cwd: string, target: string): { resolved: string; inside: boolean } {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  const realCwd = safeReal(cwd);
  const real = safeReal(abs);
  const rel = path.relative(realCwd, real);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { resolved: real, inside };
}

/** realpath the deepest existing ancestor, so not-yet-created files still resolve. */
function safeReal(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

function touchesSensitivePath(text: string): string | undefined {
  const home = homedir();
  const normalized = text.replace(/~(?=\/)/g, home);
  return SENSITIVE_PATH_FRAGMENTS.find((frag) => normalized.includes(frag))
    // a bare `.env` reference (but not .env.example inside the workspace template)
    ?? (/(^|[\s'"=/])\.env(\s|$|['"])/.test(normalized) ? '.env' : undefined);
}

/** Split a shell command into its individual invoked program names. */
function invokedPrograms(command: string): string[] {
  return command
    .split(/[;&|]+|\$\(|`|\n/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      // strip env-var prefixes like FOO=bar cmd
      const parts = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
      return path.basename(parts[0] ?? '');
    })
    .filter(Boolean);
}

function isLoopback(host: string): boolean {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/i.test(host);
}

/** Decide a single tool call. Exported for direct unit testing. */
export function evaluateToolCall(cwd: string, toolName: string, input: unknown): GuardDecision {
  const i = (input ?? {}) as Record<string, unknown>;

  // ── file tools: must stay inside the workspace ────────────────────────────
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
    const target = String(i.file_path ?? i.path ?? i.notebook_path ?? '');
    if (!target) return { allow: true };
    const sensitive = touchesSensitivePath(target);
    if (sensitive) return { allow: false, reason: `access to sensitive path (${sensitive}) is denied` };
    const { resolved, inside } = resolveWithin(cwd, target);
    if (!inside) return { allow: false, reason: `path outside the workspace: ${resolved}` };
    return { allow: true };
  }

  if (['Glob', 'Grep'].includes(toolName)) {
    const target = String(i.path ?? '');
    if (target) {
      const { resolved, inside } = resolveWithin(cwd, target);
      if (!inside) return { allow: false, reason: `search path outside the workspace: ${resolved}` };
    }
    return { allow: true };
  }

  // ── Bash: the broad one ───────────────────────────────────────────────────
  if (toolName === 'Bash') {
    const command = String(i.command ?? '');
    if (!command.trim()) return { allow: true };

    const sensitive = touchesSensitivePath(command);
    if (sensitive) return { allow: false, reason: `command touches a sensitive path (${sensitive})` };

    const programs = invokedPrograms(command);
    for (const prog of programs) {
      if (!NETWORK_COMMANDS.includes(prog)) continue;
      // Allow only loopback (the QA server / local preview).
      const hosts = [...command.matchAll(/https?:\/\/([^/\s'"]+)/gi)].map((m) => m[1].split(':')[0]);
      const allLoopback = hosts.length > 0 && hosts.every(isLoopback);
      if (!allLoopback) {
        return { allow: false, reason: `network command "${prog}" to a non-loopback host is denied` };
      }
    }

    // Absolute paths that escape the workspace (ignore standard read-only system dirs).
    // /ms-playwright is the image's shared browser install (Dockerfile) — the
    // workspace's own `pnpm shot` references it and must not be denied.
    const SYSTEM_OK = /^\/(usr|bin|sbin|lib|opt|private\/var\/folders|var\/folders|tmp|dev\/null|proc|System|Library|Applications|nix|ms-playwright)\b/;
    for (const m of command.matchAll(/(?:^|[\s'"=(])(\/[^\s'"();|&]+)/g)) {
      const p = m[1];
      if (SYSTEM_OK.test(p)) continue;
      const { resolved, inside } = resolveWithin(cwd, p);
      if (!inside) return { allow: false, reason: `command references a path outside the workspace: ${resolved}` };
    }

    // `cd ..` style escapes
    for (const m of command.matchAll(/(?:^|[\s;&|])cd\s+([^\s;&|]+)/g)) {
      const { resolved, inside } = resolveWithin(cwd, m[1]);
      if (!inside) return { allow: false, reason: `cd outside the workspace: ${resolved}` };
    }

    return { allow: true };
  }

  // ── network tools ─────────────────────────────────────────────────────────
  //
  // WebSearch runs on provider infrastructure, but its query is still an
  // outbound payload. Keep it bounded and reject secret/high-entropy strings.
  if (toolName === 'WebSearch') {
    const query = String(i.query ?? '');
    if (!isSafeSearchQuery(query)) {
      return { allow: false, reason: 'search query rejected by controlled-search policy' };
    }
    return { allow: true };
  }
  //
  // WebFetch is DENIED even when a caller lists it. Measured 2026-08-21: it
  // fetches from THIS host's egress — it reported our own public IP and was
  // served a DuckDuckGo CAPTCHA — so it is both useless for bypassing engine
  // blocks and a way for a prompt-injected page to make our server fetch an
  // arbitrary URL. Anything that must be fetched goes through `capture.ts`,
  // which stores the response as evidence.
  if (toolName === 'WebFetch') {
    return { allow: false, reason: 'WebFetch runs from the factory\'s own egress; use WebSearch or capture.ts' };
  }

  return { allow: true };
}

/** Pure controlled-search policy; never logs or returns the rejected query. */
export function isSafeSearchQuery(query: string, forbiddenValues: readonly string[] = []): boolean {
  const value = query.trim();
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/\b(?:https?|ftp|file|data):\/\//i.test(value)) return false;
  if (forbiddenValues.some((secret) => secret.length >= 8 && value.includes(secret))) return false;
  const tokens = value.match(/[A-Za-z0-9_+\/=.-]{24,}/g) ?? [];
  return !tokens.some((token) => {
    const compact = token.replace(/[=._/-]/g, '');
    const classes = [/[a-z]/.test(compact), /[A-Z]/.test(compact), /\d/.test(compact)].filter(Boolean).length;
    const uniqueRatio = new Set(compact).size / Math.max(compact.length, 1);
    return compact.length >= 24 && classes >= 2 && uniqueRatio > 0.45;
  });
}

/**
 * PreToolUse hook enforcing the workspace boundary.
 * Fail-closed: if the guard itself throws, the call is denied.
 */
export function buildPreToolUseGuard(cwd: string, agentName: string) {
  const secretValues = Object.entries(process.env)
    .filter(([name, value]) => value && (isDenied(name) || /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 8);
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const { tool_name: toolName, tool_input: toolInput } =
      (input ?? {}) as { tool_name?: string; tool_input?: unknown };
    let decision: GuardDecision;
    try {
      if (toolName === 'WebSearch') {
        const query = String((toolInput as { query?: unknown } | null)?.query ?? '');
        decision = isSafeSearchQuery(query, secretValues)
          ? { allow: true }
          : { allow: false, reason: 'search query rejected by controlled-search policy' };
      } else {
        decision = evaluateToolCall(cwd, String(toolName ?? ''), toolInput);
      }
    } catch (err) {
      decision = { allow: false, reason: `guard error: ${String(err).slice(0, 120)}` };
    }
    if (decision.allow) return {};
    log.warn('code agent tool call denied by sandbox guard', {
      agent: agentName, tool: toolName, reason: decision.reason,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Denied by the factory workspace guard: ${decision.reason}. ` +
          `Work only inside ${cwd}; do not read credentials or reach the network beyond package registries.`,
      },
    };
  };
}
