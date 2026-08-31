/**
 * Fixture-only access to the factory's named runtime volumes.
 *
 * Production Compose intentionally mounts `sites/` and `deploys/` as named
 * volumes, so writing similarly named host directories does not prepare the
 * filesystem the factory actually reads. These helpers resolve the running
 * Compose service by labels and perform narrowly scoped fixture writes as the
 * container's non-root runtime user.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertFixtureId } from './safety.js';

const execFileAsync = promisify(execFile);
export const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const FACTORY_ROOT = path.posix.resolve(process.env.E2E_FACTORY_ROOT ?? '/app');

async function factoryContainerId(): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'ps',
    '--filter', 'label=com.docker.compose.service=factory',
    '--filter', `label=com.docker.compose.project.working_dir=${PROJECT_ROOT}`,
    '--filter', 'label=com.docker.compose.oneoff=False',
    '--format', '{{.ID}}',
  ], { maxBuffer: 1024 * 1024 });
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(`expected one running factory container, found ${ids.length}`);
  }
  return ids[0]!;
}

async function factoryNode(script: string, args: string[]): Promise<string> {
  const containerId = await factoryContainerId();
  const { stdout } = await execFileAsync(
    'docker', ['exec', containerId, 'node', '-e', script, ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

function assertFixtureRuntimePath(target: string): string {
  const normalized = path.posix.resolve(target);
  const allowed = [
    `${FACTORY_ROOT}/sites/e2e-`,
    `${FACTORY_ROOT}/deploys/e2e`,
  ].some((prefix) => normalized.startsWith(prefix));
  if (!allowed) throw new Error(`refusing non-fixture runtime path: ${target}`);
  return normalized;
}

export function factoryWorkspaceDir(businessId: string, projectId: number): string {
  assertFixtureId(businessId, 'business');
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error(`invalid project id: ${projectId}`);
  return assertFixtureRuntimePath(
    path.posix.join(FACTORY_ROOT, 'sites', businessId, String(projectId)),
  );
}

export function factoryBusinessWorkspaceRoot(businessId: string): string {
  assertFixtureId(businessId, 'business');
  return assertFixtureRuntimePath(path.posix.join(FACTORY_ROOT, 'sites', businessId));
}

export function factoryDeployDir(token: string): string {
  if (!/^e2e[a-z0-9]+$/i.test(token)) throw new Error(`refusing non-fixture deploy token: ${token}`);
  return assertFixtureRuntimePath(path.posix.join(FACTORY_ROOT, 'deploys', token));
}

export async function writeFactoryFixtureFile(target: string, content: string): Promise<void> {
  const safeTarget = assertFixtureRuntimePath(target);
  await factoryNode(
    `const fs = require('node:fs');
     const path = require('node:path');
     fs.mkdirSync(path.dirname(process.argv[1]), { recursive: true });
     fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'));`,
    [safeTarget, Buffer.from(content).toString('base64')],
  );
}

export async function removeFactoryFixturePath(target: string): Promise<void> {
  const safeTarget = assertFixtureRuntimePath(target);
  await factoryNode(
    `require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });`,
    [safeTarget],
  );
}

export async function listFactoryDemoDirectories(): Promise<string[]> {
  const deployRoot = path.posix.join(FACTORY_ROOT, 'deploys');
  const stdout = await factoryNode(
    `const fs = require('node:fs');
     const root = process.argv[1];
     const dirs = fs.existsSync(root)
       ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
       : [];
     process.stdout.write(JSON.stringify(dirs));`,
    [deployRoot],
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('factory returned an invalid deploy-directory listing');
  }
  return parsed;
}
