import { REQUIRED_QUEUE_NAMES } from './jobDefinitions.js';

export interface QueueCreator {
  createQueue(name: string): Promise<unknown>;
}

/** Purely dependency-injected queue creation, usable in registry tests without DB access. */
export async function ensureRequiredQueues(queueCreator: QueueCreator): Promise<void> {
  for (const queueName of REQUIRED_QUEUE_NAMES) {
    await queueCreator.createQueue(queueName);
  }
}
