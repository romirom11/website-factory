/**
 * The model-tier policy shared by every runtime — and by the UI, which renders
 * the same rule as field fallbacks on /settings.
 *
 * There are exactly TWO model fields (`AGENT_MODEL`, `AGENT_MODEL_HEAVY`),
 * shared by all runtimes. Their REGISTRY defaults ('claude-sonnet-5',
 * 'claude-opus-5') are written for the DEFAULT runtime; a Claude-typed id must
 * never reach another harness's CLI. The rule:
 *
 *   - default runtime: the fields pass through as configured;
 *   - any other runtime: "the value came from the registry default" means
 *     UNSET — pass no model and let that CLI use its own subscription default.
 *     A saved normal model also covers the heavy tier until heavy is saved
 *     explicitly (one saved value configures both tiers of a new harness).
 *
 * '' means "omit --model". This module must stay import-free (no runtime
 * imports at all): it is copied into the UI image alongside settings.ts, where
 * repo-relative paths do not exist. Even the runtime-id union lives HERE for
 * that reason — `types.ts` re-exports it.
 */

/** Every subscription CLI harness the factory can drive. Adding one touches
 * this union, RUNTIME_LABELS (types.ts) and the registry (runtime.ts). */
export type AgentRuntimeId = 'claude-code' | 'codex' | 'opencode';

/** The registry defaults belong to this runtime. */
export const DEFAULT_RUNTIME_ID: 'claude-code' = 'claude-code';

export type SettingSource = 'process' | 'db' | 'env' | 'default';

export interface ModelInputs {
  /** Effective AGENT_MODEL, resolved db → env → ''. */
  normal: string;
  /** Effective AGENT_MODEL_HEAVY, resolved db → env → ''. */
  heavy: string;
  /** Where each effective value came from — 'default' is what triggers the rule. */
  normalSource: SettingSource;
  heavySource: SettingSource;
}

/**
 * Which model id each tier passes to the selected runtime's CLI.
 * '' = pass no --model flag; the CLI's own subscription default applies.
 */
export function effectiveModels(
  runtimeId: AgentRuntimeId,
  i: ModelInputs,
): { normal: string; heavy: string } {
  if (runtimeId === DEFAULT_RUNTIME_ID) return { normal: i.normal, heavy: i.heavy };
  const normal = i.normalSource === 'default' ? '' : i.normal;
  const heavy = i.heavySource === 'default' ? normal : i.heavy;
  return { normal, heavy };
}

/** One tier's id. Convenience wrapper over `effectiveModels`. */
export function effectiveModel(runtimeId: AgentRuntimeId, heavy: boolean | undefined, i: ModelInputs): string {
  const m = effectiveModels(runtimeId, i);
  return heavy ? m.heavy : m.normal;
}
