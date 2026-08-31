/**
 * Run a direct-handler acceptance task without competing production consumers.
 *
 * Both smoke and discovery integration invoke handlers and drain their queued
 * continuations themselves. A live core worker would race that deterministic
 * flow and could cascade fixture jobs into later stages. Pause only `factory`;
 * build workers and infrastructure stay available. The service is restored in
 * `finally` and must become healthy before the gate can continue.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { FACTORY_ISOLATION_ENV } from './e2e/isolation.js';

const TASKS = {
  smoke: ['scripts/smoke.ts'],
  integration: ['scripts/integration-e2e.ts'],
} as const;

type TaskName = keyof typeof TASKS;
type ShutdownSignal = 'SIGINT' | 'SIGTERM';

let activeChild: ChildProcess | null = null;
let interruptedBy: ShutdownSignal | null = null;
let restoringFactory = false;

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

function handleShutdown(signal: ShutdownSignal): void {
  if (interruptedBy) return;
  interruptedBy = signal;
  console.warn(`received ${signal}; restoring factory before exit`);
  // A terminal normally signals the whole foreground process group. Explicit
  // forwarding also covers supervisors that target only this wrapper process.
  if (!restoringFactory && activeChild && activeChild.exitCode === null) {
    activeChild.kill(signal);
  }
}

const onSigint = (): void => handleShutdown('SIGINT');
const onSigterm = (): void => handleShutdown('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

function selectedTask(value: string | undefined): TaskName {
  if (value === 'smoke' || value === 'integration') return value;
  throw new Error(`expected an isolated factory task: ${Object.keys(TASKS).join(' | ')}`);
}

async function runDocker(args: string[]): Promise<number> {
  console.log(`$ docker ${args.join(' ')}`);
  return new Promise<number>((resolve) => {
    const child = spawn('docker', args, { stdio: 'inherit', env: process.env });
    activeChild = child;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      resolve(code);
    };
    child.once('error', (error) => {
      console.error(error);
      finish(1);
    });
    child.once('exit', (code, signal) => finish(code ?? signalExitCode(signal)));
  });
}

const task = selectedTask(process.argv[2]);
const taskArgs = process.argv.slice(3);
const runContainerName = `websites-factory-isolated-${task}-${process.pid}`;
let stopExit = 1;
let taskExit = 1;
let startExit = 1;
try {
  stopExit = await runDocker(['compose', 'stop', 'factory']);
  if (stopExit === 0 && !interruptedBy) {
    taskExit = await runDocker([
      'compose', 'run', '--rm', '--no-deps',
      '--name', runContainerName,
      '-e', `${FACTORY_ISOLATION_ENV}=true`,
      'factory', 'pnpm', 'tsx', ...TASKS[task], ...taskArgs,
    ]);
  }
} finally {
  // `up` is idempotent even if `stop` failed before changing service state.
  // Once restoration begins, a second signal is remembered but never allowed
  // to strand the service halfway through startup.
  restoringFactory = true;
  if (interruptedBy) {
    // Killing the Compose client does not guarantee the daemon-side one-off
    // container has stopped. Remove the exact, invocation-scoped name before
    // `up --wait`; otherwise Compose can mistake that survivor for a healthy
    // `factory` instance while the canonical service remains stopped.
    await runDocker(['rm', '-f', runContainerName]);
  }
  startExit = await runDocker(['compose', 'up', '-d', '--wait', 'factory']);
  restoringFactory = false;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

if (startExit !== 0) console.error(`factory service did not restart after isolated ${task}`);
process.exitCode = interruptedBy
  ? signalExitCode(interruptedBy)
  : stopExit !== 0
    ? stopExit
    : taskExit !== 0
      ? taskExit
      : startExit;
