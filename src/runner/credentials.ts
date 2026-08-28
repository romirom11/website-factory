/** Provider credential persistence owned by the runner, never a workspace. */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  if (!root) return;
  try {
    const token = (await readFile(claudeTokenPath(root), 'utf8')).trim();
    if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  } catch { /* a disconnected provider is an ordinary state */ }
}

export async function seedRunnerClaudeCredential(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) return;
  const root = credentialRoot();
  if (!root) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = trimmed;
    return;
  }
  const file = claudeTokenPath(root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeFile(file, trimmed, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = trimmed;
}

export async function clearRunnerClaudeCredential(): Promise<void> {
  const root = credentialRoot();
  if (root) await rm(claudeTokenPath(root), { force: true });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}
