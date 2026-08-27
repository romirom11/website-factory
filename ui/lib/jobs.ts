import type { JobName } from '@factory/jobDefinitions';
import { factoryFetch } from './factoryApi';

export type { JobName } from '@factory/jobDefinitions';

export interface EnqueueInput {
  name: JobName;
  businessId?: string | null;
  campaignId?: string | null;
  idempotencyKey: string;
  data?: Record<string, unknown>;
  startAfterSeconds?: number;
  priority?: number;
}

export type EnqueueResult =
  | {
      kind: 'accepted';
      runId: string;
      runStatus: 'queued';
      attemptId: number;
      attemptSequence: number;
      bossJobId: string;
    }
  | {
      kind: 'duplicate';
      runId: string;
      runStatus: 'queued' | 'running' | 'retry_wait';
      attemptId: number | null;
      attemptSequence: number;
      bossJobId: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnqueueResult(value: unknown): EnqueueResult | null {
  if (!isRecord(value) || (value.kind !== 'accepted' && value.kind !== 'duplicate')) return null;
  if (
    typeof value.runId !== 'string'
    || !Number.isInteger(value.attemptSequence)
    || (value.attemptId !== null && !Number.isInteger(value.attemptId))
    || (value.bossJobId !== null && typeof value.bossJobId !== 'string')
  ) return null;

  if (value.kind === 'accepted') {
    if (
      value.runStatus !== 'queued'
      || !Number.isInteger(value.attemptId)
      || typeof value.bossJobId !== 'string'
    ) return null;
    return value as EnqueueResult;
  }

  if (!['queued', 'running', 'retry_wait'].includes(String(value.runStatus))) return null;
  return value as EnqueueResult;
}

/** Submit every UI-originated job through the factory's transactional command path. */
export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  const response = await factoryFetch('/internal/jobs', {
    method: 'POST',
    body: {
      name: input.name,
      payload: {
        businessId: input.businessId ?? undefined,
        campaignId: input.campaignId ?? undefined,
        idempotencyKey: input.idempotencyKey,
        ...(input.data ?? {}),
      },
      options: {
        ...(input.startAfterSeconds !== undefined
          ? { startAfterSeconds: input.startAfterSeconds }
          : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      },
    },
  });

  if (!response.ok) {
    throw new Error(response.message || `Фабрика відхилила job (${response.status}).`);
  }

  const result = parseEnqueueResult(response.body?.result);
  if (!result) {
    throw new Error('Фабрика повернула некоректну відповідь на постановку job у чергу.');
  }
  return result;
}
