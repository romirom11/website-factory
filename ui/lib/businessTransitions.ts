import {
  isBusinessStatus,
  type BusinessStatus,
  type BusinessTransitionResult,
} from '@factory/businessStatus';
import { factoryFetch } from './factoryApi';

export interface OperatorTransitionInput {
  businessId: string;
  expectedStatus: BusinessStatus;
  to: BusinessStatus;
  reason: string;
}

export interface OperatorTransitionResponse {
  ok: boolean;
  message: string;
  status: number;
  result: BusinessTransitionResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTransitionResult(value: unknown): BusinessTransitionResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'moved') {
    return isBusinessStatus(value.from) && isBusinessStatus(value.to)
      ? { kind: 'moved', from: value.from, to: value.to }
      : null;
  }
  if (value.kind === 'already_at_target') {
    return isBusinessStatus(value.status)
      ? { kind: 'already_at_target', status: value.status }
      : null;
  }
  if (value.kind === 'conflict') {
    return isBusinessStatus(value.expectedStatus) && isBusinessStatus(value.currentStatus)
      ? {
          kind: 'conflict',
          expectedStatus: value.expectedStatus,
          currentStatus: value.currentStatus,
        }
      : null;
  }
  return null;
}

/** Execute a manual status decision through the factory-owned CAS service. */
export async function operatorTransition(
  input: OperatorTransitionInput,
): Promise<OperatorTransitionResponse> {
  const response = await factoryFetch('/internal/business-transitions', {
    method: 'POST',
    body: input,
  });
  return {
    ok: response.ok,
    message: response.message,
    status: response.status,
    result: parseTransitionResult(response.body?.result),
  };
}
