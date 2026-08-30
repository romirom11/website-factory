/**
 * Run a direct-handler acceptance task without competing production consumers.
 *
 * Both smoke and discovery integration invoke handlers and drain their queued
 * continuations themselves. A live core worker would race that deterministic
 * flow and could cascade fixture jobs into later stages. Pause only `factory`;
 * build workers and infrastructure stay available. The service is restored in
 * `finally` and must become healthy before the gate can continue.
 */
import { spawn } from 'node:child_process';

const TASKS = {
  smoke: ['scripts/smoke.ts'],
  integration: ['scripts/integration-e2e.ts'],
} as const;

type TaskName = keyof typeof TASKS;

function selectedTask(value: string | undefined): TaskName {
  if (value === 'smoke' || value === 'integration') return value;
  throw new Error(`expected an isolated factory task: ${Object.keys(TASKS).join(' | ')}`);
}

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

const task = selectedTask(process.argv[2]);
const taskArgs = process.argv.slice(3);
const stopExit = await runDocker(['compose', 'stop', 'factory']);
if (stopExit !== 0) {
  process.exitCode = stopExit;
} else {
  let taskExit = 1;
  let startExit = 1;
  try {
    taskExit = await runDocker([
      'compose', 'run', '--rm', '--no-deps',
      '-e', 'E2E_FACTORY_ISOLATED=true',
      'factory', 'pnpm', 'tsx', ...TASKS[task], ...taskArgs,
    ]);
  } finally {
    startExit = await runDocker(['compose', 'up', '-d', '--wait', 'factory']);
  }
  if (startExit !== 0) console.error(`factory service did not restart after isolated ${task}`);
  process.exitCode = taskExit !== 0 ? taskExit : startExit;
}
