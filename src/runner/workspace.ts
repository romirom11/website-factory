/** Safe staging and synchronization for runner workspaces. */
import {
  appendFile,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { RunnerAttachment, RunnerPathRef } from './protocol.js';

/**
 * Workspace entries that never cross the trust boundary or sync back.
 *
 * Runtime/build caches, plus `.factory-tmp`: the agent's TMPDIR, HOME and
 * XDG_* inside the workspace (sandbox.ts, confinement.ts). Claude Code's
 * sandbox runtime keeps its `srt-mux-*.sock` unix sockets there and leaves
 * them behind when a background dev server outlives the session. A socket is
 * a "special file" to both the sync and the credential-leak gate, so a
 * finished 30-minute build was thrown away as SECURITY_VIOLATION (BEAUTIFY
 * Laser, 2026-09-04). The leak gate (secretScan.ts) skips exactly this list,
 * so the two can never disagree about what is output.
 */
export const RUNNER_PRESERVED_TOP_LEVEL: ReadonlySet<string> = new Set([
  'node_modules', '.next', '.git', '.factory-tmp', '.factory-agent-settings.json',
]);
const PRESERVED_TOP_LEVEL = RUNNER_PRESERVED_TOP_LEVEL;

export interface RunnerRoots {
  sites: string;
  inputs: string;
  work: string;
}

export function runnerRoots(): RunnerRoots {
  return {
    sites: path.resolve(process.env.RUNNER_SITES_ROOT ?? '/app/sites'),
    inputs: path.resolve(process.env.RUNNER_INPUTS_ROOT ?? '/app/agent-inputs'),
    work: path.resolve(process.env.RUNNER_WORK_ROOT ?? '/app/runner-work'),
  };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Resolve a protocol path under its allowlisted root, never an arbitrary path. */
export async function resolveRunnerPath(
  ref: RunnerPathRef,
  roots = runnerRoots(),
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const root = roots[ref.root];
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, ...ref.path.split('/'));
  if (!inside(canonicalRoot, candidate)) throw new Error('runner path escaped its allowlisted root');

  if (options.mustExist !== false) {
    const canonical = await realpath(candidate);
    if (!inside(canonicalRoot, canonical)) throw new Error('runner path resolves outside its allowlisted root');
    return canonical;
  }
  const canonicalParent = await realpath(path.dirname(candidate));
  if (canonicalParent !== canonicalRoot && !inside(canonicalRoot, canonicalParent)) {
    throw new Error('runner path parent resolves outside its allowlisted root');
  }
  return candidate;
}

export function executionPaths(requestId: string, roots = runnerRoots()): {
  root: string;
  workspace: string;
  telemetry: string;
  buildLog: string;
  manifest: string;
} {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('invalid runner request id');
  const root = path.join(roots.work, requestId);
  return {
    root,
    workspace: path.join(root, 'workspace'),
    telemetry: path.join(root, 'telemetry'),
    buildLog: path.join(root, 'telemetry', 'build-log.ndjson'),
    manifest: path.join(root, 'manifest.json'),
  };
}

function topLevel(relative: string): string {
  return relative.split(path.sep)[0] ?? relative;
}

async function assertNoSymlink(candidate: string): Promise<void> {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error(`runner staging rejects symlink: ${candidate}`);
}

/** Copy source into an isolated execution directory, preserving freshness metadata. */
export async function stageWorkspace(source: string, destination: string): Promise<void> {
  await assertNoSymlink(source);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: async (candidate) => {
      const relative = path.relative(source, candidate);
      if (relative && PRESERVED_TOP_LEVEL.has(topLevel(relative))) return false;
      await assertNoSymlink(candidate);
      return true;
    },
  });
}

/** Stage individual image attachments at gateway-chosen relative targets. */
export async function stageAttachments(
  attachments: readonly RunnerAttachment[],
  executionRoot: string,
  roots = runnerRoots(),
): Promise<void> {
  for (const attachment of attachments) {
    const source = await resolveRunnerPath(attachment.source, roots);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`runner attachment is not a regular file: ${attachment.source.path}`);
    }
    const destination = path.resolve(executionRoot, ...attachment.target.split('/'));
    if (!inside(executionRoot, destination)) throw new Error('attachment target escaped execution root');
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await utimes(destination, metadata.atime, metadata.mtime);
  }
}

async function mirrorDirectory(
  source: string,
  destination: string,
  relative = '',
  preserved = new Set<string>(),
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const sourceEntries = await readdir(source, { withFileTypes: true });
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const destinationEntries = await readdir(destination, { withFileTypes: true }).catch(() => []);

  for (const entry of destinationEntries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (PRESERVED_TOP_LEVEL.has(topLevel(childRelative))) continue;
    if (preserved.has(childRelative)) continue;
    if (!sourceNames.has(entry.name)) {
      await rm(path.join(destination, entry.name), { recursive: true, force: true });
    }
  }

  for (const entry of sourceEntries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (PRESERVED_TOP_LEVEL.has(topLevel(childRelative))) continue;
    if (preserved.has(childRelative)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) throw new Error(`runner sync rejects symlink: ${childRelative}`);
    if (metadata.isDirectory()) {
      await mirrorDirectory(from, to, childRelative, preserved);
      await utimes(to, metadata.atime, metadata.mtime).catch(() => undefined);
      continue;
    }
    if (!metadata.isFile()) throw new Error(`runner sync rejects special file: ${childRelative}`);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    await utimes(to, metadata.atime, metadata.mtime);
  }
}

/** Mirror execution output back without making untouched files look newly produced. */
export async function syncWorkspace(
  source: string,
  destination: string,
  options: { preserveRelativePaths?: readonly string[] } = {},
): Promise<void> {
  await assertNoSymlink(source);
  await assertNoSymlink(destination);
  const preserved = new Set(
    (options.preserveRelativePaths ?? []).map((value) => path.normalize(value)),
  );
  await mirrorDirectory(source, destination, '', preserved);
}

export interface RunnerManifest {
  version: 1;
  requestId: string;
  operation: 'structured' | 'code';
  requestHash: string;
  sourceWorkspace?: RunnerPathRef;
  sourceBuildLog?: RunnerPathRef;
  createdAt: string;
}

export async function writeManifest(file: string, manifest: RunnerManifest): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
}

export async function readManifest(file: string): Promise<RunnerManifest | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as RunnerManifest; } catch { return null; }
}

/**
 * Remove abandoned execution scratch after the retry/recovery window.
 *
 * Request directories are intentionally retained after completion: a factory
 * retry with the same invocation id must see the same staged output and the
 * executor's idempotent response. Age-based cleanup keeps that guarantee while
 * preventing the named volume from growing forever across gateway restarts.
 */
export async function pruneRunnerWork(
  roots = runnerRoots(),
  maxAgeMs = Number(process.env.RUNNER_WORK_RETENTION_HOURS ?? 168) * 60 * 60_000,
  protectedRequestIds: ReadonlySet<string> = new Set(),
): Promise<number> {
  await mkdir(roots.work, { recursive: true });
  const now = Date.now();
  let removed = 0;
  for (const entry of await readdir(roots.work, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    if (protectedRequestIds.has(entry.name)) continue;
    const target = path.join(roots.work, entry.name);
    const metadata = await stat(target).catch(() => null);
    if (!metadata || now - metadata.mtimeMs <= maxAgeMs) continue;
    await rm(target, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Copy a source build log into scratch and preserve its current append offset. */
export async function stageBuildLog(source: string, destination: string): Promise<number> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const metadata = await stat(source);
    await copyFile(source, destination);
    await utimes(destination, metadata.atime, metadata.mtime);
    return metadata.size;
  } catch {
    await writeFile(destination, '', 'utf8');
    return 0;
  }
}

/** Append only newly written scratch bytes to the operator-visible source log. */
export async function pumpBuildLog(
  scratch: string,
  destination: string,
  offset: number,
): Promise<number> {
  const handle = await open(scratch, 'r').catch(() => null);
  if (!handle) return offset;
  try {
    const size = (await handle.stat()).size;
    if (size <= offset) return offset;
    const delta = Buffer.allocUnsafe(size - offset);
    const { bytesRead } = await handle.read(delta, 0, delta.length, offset);
    if (bytesRead === 0) return offset;
    await mkdir(path.dirname(destination), { recursive: true });
    await appendFile(destination, delta.subarray(0, bytesRead));
    return offset + bytesRead;
  } finally {
    await handle.close();
  }
}
