/** Reject credential material before any runner output is synchronized. */
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

// These exact workspace caches never synchronize back to factory storage.
// Match the full relative path: skipping every nested directory with one of
// these names would let an agent hide a leak under output/.next/ and sync it.
const SKIPPED_RELATIVE_DIRECTORIES = new Set([
  path.join('workspace', 'node_modules'),
  path.join('workspace', '.next'),
  path.join('workspace', '.git'),
]);

export class RunnerSecurityError extends Error {
  readonly code = 'SECURITY_VIOLATION';

  constructor() {
    super('runner output failed the credential-leak security gate');
    this.name = 'RunnerSecurityError';
  }
}

async function fileContainsSecret(candidate: string, secrets: readonly Buffer[]): Promise<boolean> {
  const overlap = Math.max(...secrets.map((secret) => secret.length)) - 1;
  let tail = Buffer.alloc(0);
  for await (const rawChunk of createReadStream(candidate)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const content = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (secrets.some((secret) => content.indexOf(secret) >= 0)) return true;
    tail = overlap > 0 && content.length > overlap
      ? Buffer.from(content.subarray(content.length - overlap))
      : Buffer.from(content);
  }
  return false;
}

async function containsSecret(
  root: string,
  candidate: string,
  secrets: readonly Buffer[],
): Promise<boolean> {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
    throw new RunnerSecurityError();
  }
  if (metadata.isFile()) {
    return fileContainsSecret(candidate, secrets);
  }
  for (const entry of await readdir(candidate, { withFileTypes: true })) {
    const child = path.join(candidate, entry.name);
    if (
      entry.isDirectory()
      && SKIPPED_RELATIVE_DIRECTORIES.has(path.relative(root, child))
    ) continue;
    if (await containsSecret(root, child, secrets)) return true;
  }
  return false;
}

export async function assertNoSecretLeaks(
  root: string,
  values: readonly string[],
): Promise<void> {
  const secrets = [...new Set(values.filter((value) => value.length >= 8))].map((value) => Buffer.from(value));
  if (!secrets.length) return;
  if (await containsSecret(root, root, secrets)) throw new RunnerSecurityError();
}
