import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const factoryDir = path.join(root, 'ui', 'factory');
const dockerfile = await readFile(path.join(root, 'ui', 'Dockerfile'), 'utf8');
const entries = await readdir(factoryDir);
let checked = 0;

for (const name of entries.sort()) {
  const linkPath = path.join(factoryDir, name);
  if (!(await lstat(linkPath)).isSymbolicLink()) continue;

  const target = await readlink(linkPath);
  const source = path.relative(root, path.resolve(factoryDir, target));
  assert(!source.startsWith('..'), `${name} resolves outside the repository: ${target}`);

  const expectedCopy = `COPY ${source} ./factory/${name}`;
  assert(
    dockerfile.split('\n').some((line) => line.trim() === expectedCopy),
    `ui/Dockerfile must materialize shared symlink ${name}: add "${expectedCopy}"`,
  );
  checked++;
  console.log(`✅ ${name} -> ${source}`);
}

assert(checked > 0, 'ui/factory has no shared symlink contracts');
console.log(`\n🏭 UI SHARED CONTRACT TEST PASSED (${checked})`);
