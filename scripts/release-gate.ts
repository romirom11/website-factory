/**
 * One executable release contract. Default is the full production gate;
 * `--quick` is a developer loop and is never sufficient for a deploy decision.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { cleanupAfterFailure } from './e2e/releaseGatePolicy.js';

interface Gate {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  fullOnly?: boolean;
  /** Run this exact adjacent cleanup even when its owning gate fails. */
  cleanupAfter?: string;
}

interface GateResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
}

const root = path.resolve(new URL('..', import.meta.url).pathname);
const quick = process.argv.includes('--quick');
const transportEnv = {
  ...process.env,
  // These are local transport credentials shared only by this Compose run,
  // not model/provider credentials and not persisted to .env.
  RUNNER_API_KEY: process.env.RUNNER_API_KEY ?? randomBytes(32).toString('hex'),
  RUNNER_EXECUTOR_API_KEY: process.env.RUNNER_EXECUTOR_API_KEY ?? randomBytes(32).toString('hex'),
};

if (!quick && !transportEnv.UI_PASSWORD) {
  throw new Error('full release gate requires UI_PASSWORD in .env so browser login is real');
}
if (!quick && !transportEnv.SETTINGS_MASTER_KEY) {
  throw new Error('full release gate requires SETTINGS_MASTER_KEY in .env');
}

const gates: Gate[] = [
  { name: 'root typecheck', command: 'pnpm', args: ['typecheck'] },
  { name: 'root build', command: 'pnpm', args: ['build'] },
  { name: 'UI typecheck', command: 'corepack', args: ['pnpm', 'typecheck'], cwd: 'ui' },
  { name: 'UI production build', command: 'corepack', args: ['pnpm', 'build'], cwd: 'ui' },
  { name: 'build policy', command: 'pnpm', args: ['tsx', 'scripts/test-build-policy.ts'] },
  { name: 'brand agent', command: 'pnpm', args: ['tsx', 'scripts/test-brand-agent.ts'] },
  { name: 'workspace dependencies', command: 'pnpm', args: ['tsx', 'scripts/test-workspace-dependencies.ts'] },
  { name: 'UI shared Docker contracts', command: 'pnpm', args: ['test:ui-shared-contracts'] },
  { name: 'fixture mutation boundary', command: 'pnpm', args: ['test:fixture-safety'] },
  { name: 'campaign/global dry-run gate', command: 'pnpm', args: ['test:outreach-mode'] },
  { name: 'deterministic layout quality gates', command: 'pnpm', args: ['test:layout-quality'] },
  { name: 'status transition CAS', command: 'pnpm', args: ['test:status-transitions'] },
  { name: 'outreach decision command API', command: 'pnpm', args: ['test:outreach-decision-api'] },
  { name: 'operator business command API', command: 'pnpm', args: ['test:operator-business-api'] },
  { name: 'campaign command API', command: 'pnpm', args: ['test:campaign-command-api'] },
  { name: 'discovery transient recovery', command: 'pnpm', args: ['test:discovery-resilience'] },
  { name: 'enrichment fan-in barrier', command: 'pnpm', args: ['test:enrichment-barrier'] },
  { name: 'brand identity', command: 'pnpm', args: ['tsx', 'scripts/test-brand-identity.ts'] },
  { name: 'agent result lifecycle', command: 'pnpm', args: ['test:agent-result-lifecycle'] },
  { name: 'agent parsing/runtime contract', command: 'pnpm', args: ['tsx', 'scripts/test-agent-parsing.ts'] },
  { name: 'tmux parity', command: 'pnpm', args: ['test:tmux-agent'] },
  { name: 'logical job idempotency', command: 'pnpm', args: ['tsx', 'scripts/test-job-idempotency.ts'] },
  { name: 'rate-limit successor attempts', command: 'pnpm', args: ['tsx', 'scripts/test-rate-limit-requeue.ts'] },
  { name: 'legacy migration/reconciliation rehearsal', command: 'pnpm', args: ['tsx', 'scripts/test-reconcile.ts'] },
  { name: 'compose config', command: 'docker', args: ['compose', 'config', '--quiet'], fullOnly: true },
  { name: 'all production images build', command: 'docker', args: ['compose', 'build'], fullOnly: true },
  { name: 'compose readiness', command: 'docker', args: ['compose', 'up', '-d', '--wait'], fullOnly: true },
  { name: 'runner confinement and fail-closed degradation', command: 'pnpm', args: ['test:runner-isolation'], fullOnly: true },
  { name: 'fixture deterministic smoke', command: 'pnpm', args: ['test:smoke:compose'], fullOnly: true },
  { name: 'operator browser E2E', command: 'pnpm', args: ['e2e'], fullOnly: true },
  { name: 'discovery + approval integration', command: 'pnpm', args: ['test:integration:compose'], fullOnly: true },
  { name: 'GreenMail readiness', command: 'docker', args: ['compose', '--profile', 'dev-mail', 'up', '-d', '--wait', 'greenmail'], fullOnly: true },
  { name: 'live adapter integration against local servers', command: 'pnpm', args: ['tsx', 'scripts/phaseE-e2e.ts'], fullOnly: true },
  { name: 'F1 real multi-agent site generation', command: 'docker', args: ['compose', 'exec', '-T', 'factory', 'pnpm', 'tsx', 'scripts/phaseC-fixture.ts', '--run'], fullOnly: true },
  { name: 'F1 fixture cleanup', command: 'docker', args: ['compose', 'exec', '-T', 'factory', 'pnpm', 'tsx', 'scripts/phaseC-fixture.ts', '--clean'], fullOnly: true, cleanupAfter: 'F1 real multi-agent site generation' },
];

async function run(gate: Gate): Promise<GateResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  console.log(`\n\x1b[1m── ${gate.name} ──\x1b[0m`);
  console.log(`$ ${[gate.command, ...gate.args].join(' ')}`);
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(gate.command, gate.args, {
      cwd: path.join(root, gate.cwd ?? ''),
      env: transportEnv,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      console.error(error);
      resolve(null);
    });
    child.once('exit', (code) => resolve(code));
  });
  const result = {
    name: gate.name,
    command: [gate.command, ...gate.args].join(' '),
    ok: exitCode === 0,
    exitCode,
    startedAt,
    durationMs: Date.now() - started,
  };
  console.log(result.ok ? `✓ ${gate.name}` : `✗ ${gate.name} (exit ${exitCode ?? 'spawn error'})`);
  return result;
}

const selected = gates.filter((gate) => !gate.fullOnly || !quick);
const results: GateResult[] = [];
for (let index = 0; index < selected.length; index++) {
  const gate = selected[index]!;
  const result = await run(gate);
  results.push(result);
  // Every later full gate assumes the previous artifact/topology is current.
  // Continuing after a failed image build would test stale containers and can
  // even mutate fixture state under code that was not just built.
  if (!result.ok) {
    const cleanup = cleanupAfterFailure(selected, index);
    if (cleanup) {
      results.push(await run(cleanup));
      index++;
    }
    break;
  }
}
const skipped = selected.slice(results.length).map((gate) => gate.name);

const reportDir = path.join(root, '.artifacts', 'release-gate');
await mkdir(reportDir, { recursive: true });
const report = {
  version: 2,
  mode: quick ? 'quick-non-release' : 'full',
  generatedAt: new Date().toISOString(),
  passed: results.filter((result) => result.ok).length,
  failed: results.filter((result) => !result.ok).length,
  skipped,
  results,
};
await writeFile(path.join(reportDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\n${report.failed === 0 ? '🏭 RELEASE GATE PASSED' : '💥 RELEASE GATE FAILED'}`);
console.log(`evidence: ${path.relative(root, path.join(reportDir, 'latest.json'))}`);
process.exit(report.failed === 0 ? 0 : 1);
