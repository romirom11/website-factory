import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { redactSensitiveText } from '../lib/redaction.js';
import { RUNNER_MAX_REQUEST_BYTES } from './protocol.js';

export function runnerCredentialAuthorized(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function parseRunnerJson(context: Context): Promise<unknown> {
  const declared = Number(context.req.header('content-length') ?? 0);
  if (declared > RUNNER_MAX_REQUEST_BYTES) throw new Error('request body too large');
  const body = await context.req.text();
  if (Buffer.byteLength(body) > RUNNER_MAX_REQUEST_BYTES) throw new Error('request body too large');
  return JSON.parse(body);
}

export function safeRunnerError(error: unknown, max = 1_000): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, max);
}
