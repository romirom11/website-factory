/** Provider credential persistence owned by the runner, never a workspace. */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setSensitiveValues } from '../lib/redaction.js';

function credentialRoot(): string | null {
  const configured = (process.env.RUNNER_CREDENTIAL_ROOT ?? '').trim();
  return configured ? path.resolve(configured) : null;
}

function claudeTokenPath(root: string): string {
  return path.join(root, 'claude', 'oauth-token');
}

export function runnerCredentialStoreEnabled(): boolean {
  return credentialRoot() !== null;
}

export async function loadRunnerCredentials(): Promise<void> {
  const root = credentialRoot();
  if (root) {
    try {
      const token = (await readFile(claudeTokenPath(root), 'utf8')).trim();
      if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } catch { /* a disconnected provider is an ordinary state */ }
  }
  await refreshRunnerSensitiveValues();
}

export async function seedRunnerClaudeCredential(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) return;
  const root = credentialRoot();
  if (!root) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = trimmed;
    await refreshRunnerSensitiveValues();
    return;
  }
  const file = claudeTokenPath(root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeFile(file, trimmed, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = trimmed;
  await refreshRunnerSensitiveValues();
}

export async function clearRunnerClaudeCredential(): Promise<void> {
  const root = credentialRoot();
  if (root) await rm(claudeTokenPath(root), { force: true });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await refreshRunnerSensitiveValues();
}

function collectJsonSecrets(value: unknown, key = '', output = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (value.length >= 8 && /(?:access|refresh|token|secret|password|credential|api.?key|(?:^|[_-])key$|oauth|session)/i.test(key)) {
      output.add(value);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectJsonSecrets(child, key, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectJsonSecrets(child, childKey, output);
    }
  }
  return output;
}

async function secretsFromJson(file: string): Promise<string[]> {
  try {
    return [...collectJsonSecrets(JSON.parse(await readFile(file, 'utf8')) as unknown)];
  } catch {
    return [];
  }
}

/** Values are used only for in-memory redaction/equality scans, never logged. */
export async function runnerSensitiveValues(): Promise<string[]> {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) values.add(value);
  }
  const root = credentialRoot();
  if (root) {
    try {
      const token = (await readFile(claudeTokenPath(root), 'utf8')).trim();
      if (token.length >= 8) values.add(token);
    } catch { /* disconnected */ }
  }
  const workRoot = path.resolve(process.env.RUNNER_WORK_ROOT ?? '/app/runner-work');
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(workRoot, '.private', 'codex'));
  const openCodeData = path.resolve(process.env.XDG_DATA_HOME ?? path.join(workRoot, '.private', 'provider'));
  for (const value of await secretsFromJson(path.join(codexHome, 'auth.json'))) values.add(value);
  for (const value of await secretsFromJson(path.join(openCodeData, 'opencode', 'auth.json'))) values.add(value);
  return [...values];
}

export async function refreshRunnerSensitiveValues(): Promise<string[]> {
  const values = await runnerSensitiveValues();
  setSensitiveValues(values);
  return values;
}
