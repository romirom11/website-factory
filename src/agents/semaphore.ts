/** Live, per-worker-group capacity for subscription-backed agent calls. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerGroup } from '../orchestrator/jobDefinitions.js';
import { log } from '../lib/logger.js';

export interface SemaphoreStats {
  active: number;
  waiting: number;
  limit: number;
}

interface Waiter {
  label: string;
  resolve: () => void;
}

/** A semaphore whose cap may change without cancelling work already in flight. */
export class ResizableSemaphore {
  private active = 0;
  private limit: number;
  private readonly waiting: Waiter[] = [];

  constructor(initialLimit: number) {
    this.limit = ResizableSemaphore.normalize(initialLimit);
  }

  resize(nextLimit: number): void {
    this.limit = ResizableSemaphore.normalize(nextLimit);
    this.drain();
  }

  stats(): SemaphoreStats {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }

  async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    await this.acquire(label);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private static normalize(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }

  private async acquire(label: string): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    log.info('agent call queued (concurrency limit)', {
      label, active: this.active, limit: this.limit, waiting: this.waiting.length,
    });
    await new Promise<void>((resolve) => this.waiting.push({ label, resolve }));
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      this.active++;
      waiter.resolve();
    }
  }
}

export class AgentCapacityManager {
  private readonly groups = new Map<WorkerGroup, ResizableSemaphore>();

  resize(group: WorkerGroup, limit: number): void {
    const semaphore = this.forGroup(group);
    semaphore.resize(limit);
    log.info('agent concurrency set', { group, ...semaphore.stats() });
  }

  stats(group: WorkerGroup): SemaphoreStats {
    return this.forGroup(group).stats();
  }

  run<T>(group: WorkerGroup, label: string, operation: () => Promise<T>): Promise<T> {
    return this.forGroup(group).run(label, operation);
  }

  private forGroup(group: WorkerGroup): ResizableSemaphore {
    let semaphore = this.groups.get(group);
    if (!semaphore) {
      semaphore = new ResizableSemaphore(1);
      this.groups.set(group, semaphore);
    }
    return semaphore;
  }
}

const workerGroupContext = new AsyncLocalStorage<WorkerGroup>();
export const agentCapacityManager = new AgentCapacityManager();

/** Bind all nested runtime calls to the capacity of the worker's own group. */
export function withAgentWorkerGroup<T>(
  group: WorkerGroup,
  operation: () => Promise<T>,
): Promise<T> {
  return workerGroupContext.run(group, operation);
}

/** Current group, exported so a remote transport can preserve the context. */
export function currentAgentWorkerGroup(): WorkerGroup {
  return workerGroupContext.getStore() ?? 'core';
}

/** Run one agent call under the current worker-group slot. */
export function withAgentSlot<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const group = workerGroupContext.getStore() ?? 'core';
  return agentCapacityManager.run(group, label, operation);
}

/** Introspection for heartbeats, the dashboard and tests. */
export function agentSlotStats(group?: WorkerGroup): SemaphoreStats {
  return agentCapacityManager.stats(group ?? workerGroupContext.getStore() ?? 'core');
}
