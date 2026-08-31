import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WorkerConsumerPool,
  type ConsumerBoss,
} from '../src/orchestrator/workerConsumerPool.js';
import {
  ResizableSemaphore,
  agentCapacityManager,
  agentSlotStats,
  withAgentSlot,
  withAgentWorkerGroup,
} from '../src/agents/semaphore.js';

let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeBoss implements ConsumerBoss {
  readonly workCalls: Array<{ queue: string; options: Record<string, unknown>; id: string }> = [];
  readonly offCalls: string[] = [];

  async work(
    queue: string,
    options: Record<string, unknown>,
    _handler: (jobs: unknown[]) => Promise<unknown>,
  ): Promise<string> {
    const id = `${queue}-${this.workCalls.length + 1}`;
    this.workCalls.push({ queue, options, id });
    return id;
  }

  async offWork(options: { id: string }): Promise<void> {
    this.offCalls.push(options.id);
  }
}

class FlakyBoss extends FakeBoss {
  failNextWork = false;
  failNextOffWork = false;

  override async work(
    queue: string,
    options: Record<string, unknown>,
    handler: (jobs: unknown[]) => Promise<unknown>,
  ): Promise<string> {
    if (this.failNextWork) {
      this.failNextWork = false;
      throw new Error('injected work failure');
    }
    return super.work(queue, options, handler);
  }

  override async offWork(options: { id: string }): Promise<void> {
    if (this.failNextOffWork) {
      this.failNextOffWork = false;
      throw new Error('injected offWork failure');
    }
    return super.offWork(options);
  }
}

await check('consumer pool grows and shrinks through supported worker handles', async () => {
  const boss = new FakeBoss();
  const pool = new WorkerConsumerPool('build', boss, async () => {});

  await pool.resize(1);
  assert.equal(pool.stats().target, 1);
  assert.equal(pool.stats().handles, 1);
  assert.deepEqual(boss.workCalls.map((call) => call.queue), ['agent-build']);
  assert.deepEqual(boss.workCalls[0]?.options, { batchSize: 1, priority: true });

  await pool.resize(2);
  assert.equal(pool.stats().handles, 2);
  await pool.resize(1);
  assert.equal(pool.stats().handles, 1);
  assert.equal(boss.offCalls.length, 1);
  assert.equal(boss.offCalls[0], boss.workCalls[1]?.id);
});

await check('rapid resize requests serialize and converge on the last cap', async () => {
  const boss = new FakeBoss();
  const pool = new WorkerConsumerPool('enrich', boss, async () => {});
  await Promise.all([pool.resize(1), pool.resize(3), pool.resize(2), pool.resize(1)]);
  assert.deepEqual(pool.stats(), {
    group: 'enrich', queue: 'agent-enrich', target: 1, handles: 1,
  });
  assert.equal(boss.workCalls.length - boss.offCalls.length, 1);
});

await check('a transient resize failure preserves real handles and remains retryable', async () => {
  const boss = new FlakyBoss();
  const pool = new WorkerConsumerPool('build', boss, async () => {});
  boss.failNextWork = true;
  await assert.rejects(pool.resize(2), /injected work failure/);
  assert.equal(pool.stats().handles, 0);
  await pool.resize(2);
  assert.equal(pool.stats().handles, 2);

  boss.failNextOffWork = true;
  await assert.rejects(pool.resize(1), /injected offWork failure/);
  assert.equal(pool.stats().handles, 2);
  await pool.resize(1);
  assert.equal(pool.stats().handles, 1);
});

await check('worker groups own independent physical pools', async () => {
  const boss = new FakeBoss();
  const core = new WorkerConsumerPool('core', boss, async () => {});
  const enrich = new WorkerConsumerPool('enrich', boss, async () => {});
  await core.resize(2);
  await enrich.resize(1);
  assert.equal(core.stats().handles, 2);
  assert.equal(enrich.stats().handles, 1);
  assert.deepEqual(new Set(boss.workCalls.map((call) => call.queue)), new Set(['agent-core', 'agent-enrich']));
});

await check('cap reduction never interrupts active work or releases a waiter early', async () => {
  const semaphore = new ResizableSemaphore(2);
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const run = (id: string) => semaphore.run(id, async () => {
    started.push(id);
    await new Promise<void>((resolve) => releases.push(resolve));
  });

  const first = run('first');
  const second = run('second');
  const third = run('third');
  await Promise.resolve();
  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(semaphore.stats(), { active: 2, waiting: 1, limit: 2 });

  semaphore.resize(1);
  releases.shift()!();
  await flush();
  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(semaphore.stats(), { active: 1, waiting: 1, limit: 1 });

  releases.shift()!();
  await flush();
  assert.deepEqual(started, ['first', 'second', 'third']);
  releases.shift()!();
  await Promise.all([first, second, third]);
  assert.deepEqual(semaphore.stats(), { active: 0, waiting: 0, limit: 1 });
});

await check('cap increase releases eligible waiters immediately', async () => {
  const semaphore = new ResizableSemaphore(1);
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const run = (id: string) => semaphore.run(id, async () => {
    started.push(id);
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const tasks = [run('a'), run('b')];
  await Promise.resolve();
  assert.deepEqual(started, ['a']);
  semaphore.resize(2);
  await flush();
  assert.deepEqual(started, ['a', 'b']);
  releases.splice(0).forEach((release) => release());
  await Promise.all(tasks);
});

await check('worker group context selects independent agent semaphores', async () => {
  agentCapacityManager.resize('core', 1);
  agentCapacityManager.resize('enrich', 2);
  const observed = await Promise.all([
    withAgentWorkerGroup('core', () => withAgentSlot('core-test', async () => agentSlotStats())),
    withAgentWorkerGroup('enrich', () => withAgentSlot('enrich-test', async () => agentSlotStats())),
  ]);
  assert.equal(observed[0].limit, 1);
  assert.equal(observed[1].limit, 2);
  assert.equal(agentSlotStats('core').active, 0);
  assert.equal(agentSlotStats('enrich').active, 0);
});

await check('installed worker options contain no unsupported team fields', async () => {
  const source = await readFile(new URL('../src/orchestrator/queue.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /teamSize|teamConcurrency/);
});

console.log(`\n🏭 WORKER CONSUMER POOL TESTS PASSED (${passed})`);
