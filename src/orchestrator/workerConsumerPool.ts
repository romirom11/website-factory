import {
  JOB_DEFINITIONS,
  type WorkerGroup,
} from './jobDefinitions.js';

export interface ConsumerBoss {
  work(
    queue: string,
    options: Record<string, unknown>,
    handler: (jobs: any[]) => Promise<unknown>,
  ): Promise<string>;
  offWork(options: { id: string }): Promise<void>;
}

export interface WorkerConsumerPoolStats {
  group: WorkerGroup;
  queue: string;
  target: number;
  handles: number;
}

function physicalAgentQueue(group: WorkerGroup): string {
  const queues = new Set(
    JOB_DEFINITIONS
      .filter((definition) => (
        definition.workerGroup === group
        && definition.agentCapability === 'subscription'
      ))
      .map((definition) => definition.physicalQueue),
  );
  if (queues.size !== 1) {
    throw new Error(`worker group ${group} must map to exactly one agent queue`);
  }
  return [...queues][0]!;
}

/**
 * Maintains one supported pg-boss worker handle per desired group consumer.
 * Shrinking stops polling handles; pg-boss lets callbacks already running finish.
 */
export class WorkerConsumerPool {
  private readonly queue: string;
  private readonly handles: string[] = [];
  private target = 0;
  private resizeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly group: WorkerGroup,
    private readonly boss: ConsumerBoss,
    private readonly handler: (jobs: any[]) => Promise<unknown>,
  ) {
    this.queue = physicalAgentQueue(group);
  }

  resize(value: number): Promise<void> {
    const target = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    // A transient pg-boss failure must not poison the serialization chain: the
    // next settings refresh retries from the handles that actually exist.
    this.resizeChain = this.resizeChain
      .catch(() => undefined)
      .then(() => this.applyResize(target));
    return this.resizeChain;
  }

  stats(): WorkerConsumerPoolStats {
    return {
      group: this.group,
      queue: this.queue,
      target: this.target,
      handles: this.handles.length,
    };
  }

  private async applyResize(target: number): Promise<void> {
    this.target = target;
    while (this.handles.length < target) {
      const id = await this.boss.work(
        this.queue,
        { batchSize: 1, priority: true },
        this.handler,
      );
      this.handles.push(id);
    }
    while (this.handles.length > target) {
      const id = this.handles[this.handles.length - 1]!;
      await this.boss.offWork({ id });
      this.handles.pop();
    }
  }
}
