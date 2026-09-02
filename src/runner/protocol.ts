/**
 * Versioned wire contract between the factory, runner gateway and executor.
 *
 * Only JSON-safe data crosses this boundary. Zod schemas remain caller-owned:
 * the factory sends their JSON-Schema representation for model guidance, then
 * validates the returned value/artifact with the original Zod instance.
 */
import { z } from 'zod';
import type { AgentUsage } from '../agents/types.js';

export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const RUNNER_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const SafeRelativePathSchema = z.string().min(1).max(1_000).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/')
    && !normalized.includes('\0')
    && normalized.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}, 'path must be a normalized relative path without traversal');

export const RunnerPathRefSchema = z.object({
  root: z.enum(['sites', 'inputs']),
  path: SafeRelativePathSchema,
});
export type RunnerPathRef = z.infer<typeof RunnerPathRefSchema>;

export const RunnerAttachmentSchema = z.object({
  source: RunnerPathRefSchema,
  target: SafeRelativePathSchema,
});
export type RunnerAttachment = z.infer<typeof RunnerAttachmentSchema>;

const JsonSchemaSchema = z.record(z.unknown());
const RuntimeSchema = z.enum(['claude-code', 'codex', 'opencode']);
const AgentKindSchema = z.enum([
  'enrichment', 'qa', 'content', 'design', 'outreach', 'builder', 'visual-critique',
]);
const SkillsSchema = z.union([z.literal('all'), z.array(z.string().min(1).max(120)).max(50)]);

const BaseExecutionSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  runtime: RuntimeSchema,
  model: z.string().max(200).optional(),
  claudeCredential: z.string().min(1).max(2_000).optional(),
  capacity: z.object({
    group: z.enum(['core', 'enrich', 'build']),
    limit: z.number().int().min(1).max(8),
  }),
});

export const StructuredExecutionRequestSchema = BaseExecutionSchema.extend({
  operation: z.literal('structured'),
  name: z.string().min(1).max(200),
  systemPrompt: z.string().max(500_000),
  userContent: z.string().max(1_000_000),
  outputJsonSchema: JsonSchemaSchema,
  workspace: RunnerPathRefSchema.optional(),
  buildLog: RunnerPathRefSchema.optional(),
  attachments: z.array(RunnerAttachmentSchema).max(60).default([]),
  options: z.object({
    heavy: z.boolean().optional(),
    retries: z.number().int().min(0).max(10).optional(),
    kind: AgentKindSchema.optional(),
    timeoutMs: z.number().int().min(1_000).max(2 * 60 * 60_000).optional(),
    maxTurns: z.number().int().min(1).max(1_000).optional(),
  }),
});
export type StructuredExecutionRequest = z.infer<typeof StructuredExecutionRequestSchema>;

export const CodeExecutionRequestSchema = BaseExecutionSchema.extend({
  operation: z.literal('code'),
  name: z.string().min(1).max(200),
  prompt: z.string().max(1_000_000),
  appendSystemPrompt: z.string().max(500_000).optional(),
  outputJsonSchema: JsonSchemaSchema,
  workspace: RunnerPathRefSchema,
  buildLog: RunnerPathRefSchema.optional(),
  invocation: z.object({
    id: z.string().uuid(),
    notBeforeMs: z.number().int().positive(),
  }),
  options: z.object({
    maxTurns: z.number().int().min(1).max(1_000).optional(),
    heavy: z.boolean().optional(),
    kind: AgentKindSchema.optional(),
    timeoutMs: z.number().int().min(1_000).max(2 * 60 * 60_000).optional(),
    allowedTools: z.array(z.string().min(1).max(100)).max(100).optional(),
    skills: SkillsSchema.optional(),
    terminal: z.boolean(),
    terminalWeb: z.boolean().optional(),
    terminalWritable: z.boolean().optional(),
    terminalPort: z.number().int().min(1).max(65_535).optional(),
  }),
});
export type CodeExecutionRequest = z.infer<typeof CodeExecutionRequestSchema>;

export const ExecutionRequestSchema = z.discriminatedUnion('operation', [
  StructuredExecutionRequestSchema,
  CodeExecutionRequestSchema,
]);
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const RunnerErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'RUNNER_UNAVAILABLE',
  'EXECUTION_FAILED',
  'SECURITY_VIOLATION',
  'RATE_LIMITED',
  'NEEDS_HUMAN',
  'CANCELLED',
]);
export type RunnerErrorCode = z.infer<typeof RunnerErrorCodeSchema>;

export const RunnerErrorSchema = z.object({
  code: RunnerErrorCodeSchema,
  message: z.string().max(2_000),
  retryAfterMs: z.number().int().positive().optional(),
  rateLimitType: z.string().max(200).optional(),
  resetsAt: z.string().datetime().optional(),
  runtime: RuntimeSchema.optional(),
});
export type RunnerError = z.infer<typeof RunnerErrorSchema>;

const UsageSchema = z.object({
  runtime: RuntimeSchema,
  model: z.string().optional(),
  numTurns: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number(),
});

export const ExecutionResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    value: z.unknown().optional(),
    usage: UsageSchema.optional(),
  }),
  z.object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: RunnerErrorSchema,
    usage: UsageSchema.optional(),
  }),
]);
export type ExecutionResponse = z.infer<typeof ExecutionResponseSchema>;

export interface SuccessfulExecutionResponse {
  version: typeof RUNNER_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  value?: unknown;
  usage?: AgentUsage;
}

export type AgentAccountProvider = 'claude' | 'codex' | 'opencode';
export type AgentCheckProvider = 'claude' | 'codex' | 'opencode';

/** OpenCode provider ids are catalog keys (models.dev), e.g. `zai-coding-plan`. */
export const OpenCodeProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const AccountControlRequestSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  /**
   * start/submit-code/cancel drive the interactive Claude/Codex CLIs;
   * connect stores an OpenCode provider key (providerId + secret);
   * disconnect removes a credential (OpenCode: the one provider named).
   */
  operation: z.enum(['start', 'status', 'submit-code', 'cancel', 'connect', 'disconnect']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  code: z.string().max(10_000).optional(),
  providerId: OpenCodeProviderIdSchema.optional(),
  secret: z.string().min(1).max(4_000).optional(),
});
export type AccountControlRequest = z.infer<typeof AccountControlRequestSchema>;

export const AgentCheckRequestSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  provider: z.enum(['claude', 'codex', 'opencode']),
  model: z.string().max(200).optional(),
  claudeCredential: z.string().min(1).max(2_000).optional(),
});
export type AgentCheckRequest = z.infer<typeof AgentCheckRequestSchema>;

export const TerminalControlRequestSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  operation: z.enum(['status', 'cancel']),
  workspace: RunnerPathRefSchema,
});
export type TerminalControlRequest = z.infer<typeof TerminalControlRequestSchema>;

export const ExecutorTerminalRequestSchema = z.object({
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  operation: z.literal('cancel'),
  requestId: z.string().uuid(),
});

export const ControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    version: z.literal(RUNNER_PROTOCOL_VERSION),
    ok: z.literal(false),
    error: RunnerErrorSchema,
  }),
]);
export type ControlResponse = z.infer<typeof ControlResponseSchema>;
