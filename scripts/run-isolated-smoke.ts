/**
 * Run the direct-handler smoke test without competing production consumers.
 *
 * The smoke intentionally invokes deterministic handlers itself. Leaving the
 * core factory worker active would let that second process consume the jobs
 * those handlers enqueue, making business status depend on scheduler timing.
 * Only the core/enrichment service is paused; build workers and infrastructure
 * stay available. The service is always restarted before this command exits.
 */
import { spawn } from 'node:child_process';

async function runDocker(args: string[]): Promise<number> {
  console.log(`$ docker ${args.join(' ')}`);
  return new Promise<number>((resolve) => {
    const child = spawn('docker', args, { stdio: 'inherit', env: process.env });
    child.once('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const stopExit = await runDocker(['compose', 'stop', 'factory']);
if (stopExit !== 0) {
  process.exitCode = stopExit;
} else {
  let smokeExit = 1;
  let startExit = 1;
  try {
    smokeExit = await runDocker([
      'compose', 'run', '--rm', '--no-deps',
      'factory', 'pnpm', 'tsx', 'scripts/smoke.ts',
    ]);
  } finally {
    startExit = await runDocker(['compose', 'start', 'factory']);
  }
  if (startExit !== 0) console.error('factory service did not restart after isolated smoke');
  process.exitCode = smokeExit !== 0 ? smokeExit : startExit;
}
