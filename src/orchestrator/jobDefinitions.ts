/**
 * Import-free job contract shared by the factory, workers and control UI.
 *
 * Keep this module free of Node, database and framework imports: the UI consumes
 * the exact same file through `ui/factory/jobDefinitions.ts`, including in its
 * Docker build. Runtime services may execute the policy declared here; they may
 * not maintain a second retry, expiry, grouping or display-name table.
 */

export const WORKER_GROUP_NAMES = ['core', 'enrich', 'build'] as const;
export type WorkerGroup = typeof WORKER_GROUP_NAMES[number];

export type AgentCapability = 'none' | 'subscription';
export type SchedulingClass = 'upstream' | 'continuation' | 'delivery' | 'scheduled';
export type PayloadValueType =
  | 'nonEmptyString'
  | 'integer'
  | 'boolean'
  | 'record'
  | 'array'
  | 'stringArray';

export interface JobPayloadSchema {
  required: Readonly<Record<string, PayloadValueType>>;
  optional: Readonly<Record<string, PayloadValueType>>;
  /** Existing handlers carry stage-specific evidence fields not owned by queue policy. */
  allowAdditional: boolean;
}

export interface JobDefinition {
  name: string;
  physicalQueue: string;
  workerGroup: WorkerGroup;
  agentCapability: AgentCapability;
  retry: Readonly<{ limit: number; delaySeconds: number }>;
  expireInSeconds: number;
  schedulingClass: SchedulingClass;
  displayName: string;
  manualRequeue: boolean;
  payloadSchema: JobPayloadSchema;
}

const ID_FIELDS = {
  optional: {
    campaignId: 'nonEmptyString',
    idempotencyKey: 'nonEmptyString',
  },
  allowAdditional: true,
} as const;

const CAMPAIGN_PAYLOAD = {
  required: { campaignId: 'nonEmptyString' },
  ...ID_FIELDS,
} as const satisfies JobPayloadSchema;

const BUSINESS_PAYLOAD = {
  required: { businessId: 'nonEmptyString' },
  optional: {
    ...ID_FIELDS.optional,
    projectId: 'integer',
    approvalId: 'integer',
    iteration: 'integer',
    followupIndex: 'integer',
    designAttempt: 'integer',
    designFeedback: 'nonEmptyString',
    issues: 'stringArray',
    imageUrls: 'array',
    silent: 'boolean',
  },
  allowAdditional: true,
} as const satisfies JobPayloadSchema;

const NORMALIZE_PAYLOAD = {
  required: { campaignId: 'nonEmptyString', candidate: 'record' },
  optional: ID_FIELDS.optional,
  allowAdditional: true,
} as const satisfies JobPayloadSchema;

const GLOBAL_PAYLOAD = {
  required: {},
  optional: { idempotencyKey: 'nonEmptyString', silent: 'boolean' },
  allowAdditional: true,
} as const satisfies JobPayloadSchema;

const DEFAULT_RETRY = { limit: 3, delaySeconds: 60 } as const;
const STANDARD_EXPIRY = 30 * 60;
const AGENT_EXPIRY = 90 * 60;

function definition<const T extends Omit<JobDefinition, 'physicalQueue'>>(
  input: T,
): T & { physicalQueue: string } {
  return {
    ...input,
    physicalQueue: input.agentCapability === 'subscription'
      ? `agent-${input.workerGroup}`
      : input.name,
  };
}

export const JOB_DEFINITIONS = [
  definition({ name: 'discover', workerGroup: 'core', agentCapability: 'none', retry: { limit: 2, delaySeconds: 60 }, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'upstream', displayName: 'пошук бізнесів', manualRequeue: false, payloadSchema: CAMPAIGN_PAYLOAD }),
  definition({ name: 'normalize', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'upstream', displayName: 'впорядкування знайденого', manualRequeue: false, payloadSchema: NORMALIZE_PAYLOAD }),
  definition({ name: 'fast-qualify', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'upstream', displayName: 'первинний відбір', manualRequeue: false, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'enrich', workerGroup: 'enrich', agentCapability: 'subscription', retry: { limit: 3, delaySeconds: 120 }, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'upstream', displayName: 'збір даних про бізнес', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'enrich-socials', workerGroup: 'enrich', agentCapability: 'subscription', retry: { limit: 1, delaySeconds: 120 }, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'upstream', displayName: 'пошук соцмереж', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'refresh-brand', workerGroup: 'enrich', agentCapability: 'subscription', retry: { limit: 2, delaySeconds: 30 }, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'continuation', displayName: 'оновлення айдентики', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'collect-assets', workerGroup: 'core', agentCapability: 'subscription', retry: DEFAULT_RETRY, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'upstream', displayName: 'збір фотографій', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'audit-website', workerGroup: 'core', agentCapability: 'none', retry: { limit: 3, delaySeconds: 60 }, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'upstream', displayName: 'перевірка їхнього сайту', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'score-and-qa', workerGroup: 'enrich', agentCapability: 'subscription', retry: DEFAULT_RETRY, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'continuation', displayName: 'оцінка бізнесу', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'readiness-gate', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'continuation', displayName: 'перевірка готовності', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'content-and-design', workerGroup: 'build', agentCapability: 'subscription', retry: DEFAULT_RETRY, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'continuation', displayName: 'підготовка дизайну', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'build-site', workerGroup: 'build', agentCapability: 'subscription', retry: { limit: 1, delaySeconds: 0 }, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'continuation', displayName: 'збірка демосайту', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'visual-qa', workerGroup: 'build', agentCapability: 'subscription', retry: DEFAULT_RETRY, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'continuation', displayName: 'перевірка демосайту', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'deploy-demo', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'continuation', displayName: 'публікація демо', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'request-approval', workerGroup: 'core', agentCapability: 'subscription', retry: DEFAULT_RETRY, expireInSeconds: AGENT_EXPIRY, schedulingClass: 'continuation', displayName: 'підготовка до відправки', manualRequeue: true, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'send-outreach', workerGroup: 'core', agentCapability: 'none', retry: { limit: 0, delaySeconds: 0 }, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'delivery', displayName: 'відправка повідомлення', manualRequeue: false, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'send-followup', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'delivery', displayName: 'нагадування', manualRequeue: false, payloadSchema: BUSINESS_PAYLOAD }),
  definition({ name: 'poll-replies', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'scheduled', displayName: 'перевірка відповідей', manualRequeue: false, payloadSchema: GLOBAL_PAYLOAD }),
  definition({ name: 'daily-summary', workerGroup: 'core', agentCapability: 'none', retry: DEFAULT_RETRY, expireInSeconds: STANDARD_EXPIRY, schedulingClass: 'scheduled', displayName: 'щоденний звіт', manualRequeue: false, payloadSchema: GLOBAL_PAYLOAD }),
] as const;

export type JobName = typeof JOB_DEFINITIONS[number]['name'];

export function validateJobDefinitions(
  definitions: readonly JobDefinition[],
): void {
  const names = new Set<string>();
  for (const item of definitions) {
    if (!item.name) throw new Error('job definition name must not be empty');
    if (names.has(item.name)) throw new Error(`duplicate job definition: ${item.name}`);
    names.add(item.name);

    if (!WORKER_GROUP_NAMES.includes(item.workerGroup)) {
      throw new Error(`invalid worker group for ${item.name}: ${item.workerGroup}`);
    }
    if (!item.displayName.trim()) throw new Error(`display name missing for ${item.name}`);
    if (!Number.isInteger(item.retry.limit) || item.retry.limit < 0) {
      throw new Error(`invalid retry limit for ${item.name}`);
    }
    if (!Number.isInteger(item.retry.delaySeconds) || item.retry.delaySeconds < 0) {
      throw new Error(`invalid retry delay for ${item.name}`);
    }
    if (!Number.isInteger(item.expireInSeconds) || item.expireInSeconds <= 0) {
      throw new Error(`invalid expiry for ${item.name}`);
    }

    const expectedQueue = item.agentCapability === 'subscription'
      ? `agent-${item.workerGroup}`
      : item.name;
    if (item.physicalQueue !== expectedQueue) {
      throw new Error(`invalid physical queue for ${item.name}: expected ${expectedQueue}`);
    }
  }
}

validateJobDefinitions(JOB_DEFINITIONS);

export const JOB_NAMES = Object.freeze(
  JOB_DEFINITIONS.map((item) => item.name),
) as readonly JobName[];

const DEFINITIONS_BY_NAME = new Map<string, JobDefinition>(
  JOB_DEFINITIONS.map((item) => [item.name, item]),
);

export const PHYSICAL_QUEUE_NAMES = Object.freeze(
  [...new Set(JOB_DEFINITIONS.map((item) => item.physicalQueue))],
) as readonly string[];

/**
 * U1 still writes agent jobs to their legacy logical queues. Creating both the
 * logical and target physical queues makes that compatibility explicit until
 * U3 switches writers and drains the legacy queues.
 */
export const REQUIRED_QUEUE_NAMES = Object.freeze(
  [...new Set<string>([...JOB_NAMES, ...PHYSICAL_QUEUE_NAMES])],
) as readonly string[];

export const MANUAL_REQUEUE_JOB_NAMES = Object.freeze(
  JOB_DEFINITIONS.filter((item) => item.manualRequeue).map((item) => item.name),
) as readonly JobName[];

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && DEFINITIONS_BY_NAME.has(value);
}

export function getJobDefinition(name: unknown): JobDefinition & { name: JobName } {
  const item = typeof name === 'string' ? DEFINITIONS_BY_NAME.get(name) : undefined;
  if (!item) throw new Error(`unknown job name: ${String(name)}`);
  return item as JobDefinition & { name: JobName };
}

export function jobDisplayName(name: unknown): string {
  return isJobName(name) ? getJobDefinition(name).displayName : String(name);
}

export function jobDisplayTitle(name: unknown): string {
  const label = jobDisplayName(name);
  return label ? `${label[0]!.toLocaleUpperCase('uk-UA')}${label.slice(1)}` : label;
}

function validValue(value: unknown, type: PayloadValueType): boolean {
  switch (type) {
    case 'nonEmptyString': return typeof value === 'string' && value.trim().length > 0;
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'record': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'stringArray': return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

export type JobPayloadValidation =
  | { ok: true }
  | { ok: false; issues: string[] };

export function validateJobPayload(name: unknown, payload: unknown): JobPayloadValidation {
  const definition = getJobDefinition(name);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, issues: ['payload must be an object'] };
  }

  const values = payload as Record<string, unknown>;
  const issues: string[] = [];
  for (const [field, type] of Object.entries(definition.payloadSchema.required)) {
    if (!validValue(values[field], type)) issues.push(`${field} must be a ${type === 'nonEmptyString' ? 'non-empty string' : type}`);
  }
  for (const [field, type] of Object.entries(definition.payloadSchema.optional)) {
    if (values[field] !== undefined && !validValue(values[field], type)) {
      issues.push(`${field} must be a ${type === 'nonEmptyString' ? 'non-empty string' : type} when provided`);
    }
  }

  if (!definition.payloadSchema.allowAdditional) {
    const allowed = new Set([
      ...Object.keys(definition.payloadSchema.required),
      ...Object.keys(definition.payloadSchema.optional),
    ]);
    for (const field of Object.keys(values)) {
      if (!allowed.has(field)) issues.push(`${field} is not allowed`);
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true };
}
