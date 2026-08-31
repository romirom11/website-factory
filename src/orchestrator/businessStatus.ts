export const BUSINESS_STATUSES = [
  'discovered', 'prequalified', 'enriching', 'needs_review', 'qualified',
  'production_ready', 'site_in_progress', 'site_ready', 'outreach_approved',
  'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost',
  // terminal/exception
  'rejected', 'duplicate', 'closed', 'do_not_contact',
] as const;

export type BusinessStatus = typeof BUSINESS_STATUSES[number];

const BUSINESS_STATUS_SET = new Set<string>(BUSINESS_STATUSES);

export function isBusinessStatus(value: unknown): value is BusinessStatus {
  return typeof value === 'string' && BUSINESS_STATUS_SET.has(value);
}

export function requireBusinessStatus(
  value: unknown,
  context = 'business',
): BusinessStatus {
  if (!isBusinessStatus(value)) {
    throw new Error(`${context} has unknown status: ${String(value)}`);
  }
  return value;
}

/** Allowed forward workflow edges. Overrides and recovery are separate APIs. */
const TRANSITIONS: Partial<Record<BusinessStatus, readonly BusinessStatus[]>> = {
  discovered: ['prequalified', 'rejected', 'duplicate', 'needs_review'],
  prequalified: ['enriching', 'rejected', 'needs_review'],
  enriching: ['needs_review', 'qualified', 'rejected'],
  needs_review: ['enriching', 'qualified', 'rejected', 'production_ready'],
  qualified: ['production_ready', 'enriching', 'needs_review', 'rejected'],
  production_ready: ['site_in_progress'],
  site_in_progress: ['site_ready', 'needs_review'],
  site_ready: ['outreach_approved', 'needs_review', 'rejected'],
  outreach_approved: ['contacted'],
  contacted: ['replied', 'closed', 'do_not_contact'],
  replied: ['meeting', 'proposal', 'won', 'lost', 'do_not_contact'],
  meeting: ['proposal', 'won', 'lost'],
  proposal: ['won', 'lost'],
};

export function isAllowedBusinessTransition(
  from: BusinessStatus,
  to: BusinessStatus,
): boolean {
  return from === to || (TRANSITIONS[from] ?? []).includes(to);
}

export type BusinessTransitionResult =
  | { kind: 'moved'; from: BusinessStatus; to: BusinessStatus }
  | { kind: 'already_at_target'; status: BusinessStatus }
  | {
    kind: 'conflict';
    expectedStatus: BusinessStatus;
    currentStatus: BusinessStatus;
  };
