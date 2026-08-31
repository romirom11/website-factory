export type DoNotContactMatchType = 'business_id' | 'email' | 'phone' | 'domain';

/** Canonical storage and lookup form for compliance addresses. */
export function normalizeDoNotContactValue(
  matchType: DoNotContactMatchType,
  value: string,
): string {
  const trimmed = value.trim();
  if (matchType === 'email' || matchType === 'domain') return trimmed.toLowerCase();
  if (matchType === 'phone') return trimmed.replace(/[^\d]/g, '');
  return trimmed;
}
