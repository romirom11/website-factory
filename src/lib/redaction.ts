/** In-process secret redaction for runner logs and operator telemetry. */
function normalized(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length >= 8))]
    .sort((left, right) => right.length - left.length);
}

// Every process starts with its own secret-shaped environment values covered.
// Runner credential files are merged in later by refreshRunnerSensitiveValues.
let sensitiveValues = normalized(
  Object.entries(process.env)
    .filter(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
    .map(([, value]) => value as string),
);

export function setSensitiveValues(values: readonly string[]): void {
  sensitiveValues = normalized(values);
}

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const secret of sensitiveValues) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted;
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, redactSensitiveValue(child)]),
    );
  }
  return value;
}
