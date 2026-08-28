/**
 * zod -> JSON Schema conversion + robust JSON extraction from model output.
 * Schemas in this project stay simple (objects/arrays/primitives/enums/unions),
 * so a compact converter beats pulling in another dependency.
 */
import type { ZodType } from 'zod';

export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: any })._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v as ZodType);
        if (!(v as { isOptional(): boolean }).isOptional()) required.push(k);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray': return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodString': return { type: 'string' };
    case 'ZodNumber': return { type: 'number' };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodEnum': return { type: 'string', enum: def.values };
    case 'ZodNullable': return { anyOf: [zodToJsonSchema(def.innerType), { type: 'null' }] };
    case 'ZodOptional': return zodToJsonSchema(def.innerType);
    case 'ZodDefault': return zodToJsonSchema(def.innerType);
    case 'ZodRecord': return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };
    case 'ZodLiteral': return { const: def.value };
    case 'ZodUnion': return { anyOf: def.options.map((o: ZodType) => zodToJsonSchema(o)) };
    case 'ZodEffects': return zodToJsonSchema(def.schema);
    default: return {};
  }
}

/** The exact JSON Schema shown to a runtime, with a remote contract override. */
export function outputJsonSchema(
  schema: ZodType,
  override?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return override ? { ...override } : zodToJsonSchema(schema);
}

/**
 * Pull a JSON value out of model output that may be wrapped in prose or fences.
 * Tries, in order: the whole string, fenced blocks, then the outermost
 * balanced {...} / [...] span. Returns undefined if nothing parses.
 */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // ```json ... ``` or ``` ... ```
  const fenceRe = /```(?:json|jsonc)?\s*\n?([\s\S]*?)```/gi;
  for (const m of trimmed.matchAll(fenceRe)) {
    const parsed = tryParse(m[1].trim());
    if (parsed !== undefined) return parsed;
  }

  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const span = balancedSpan(trimmed, open, close);
    if (span !== undefined) {
      const parsed = tryParse(span);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Outermost balanced span, ignoring braces inside JSON string literals. */
function balancedSpan(s: string, open: string, close: string): string | undefined {
  const start = s.indexOf(open);
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Prompt suffix that pins the model to schema-shaped JSON when no native structured output is available. */
export function jsonOnlyInstruction(
  schema: ZodType,
  override?: Readonly<Record<string, unknown>>,
): string {
  return (
    '\n\nOUTPUT CONTRACT (mandatory):\n' +
    'Reply with a SINGLE JSON value and NOTHING else — no prose, no explanation, no markdown code fences.\n' +
    'It must validate against this JSON Schema:\n' +
    JSON.stringify(outputJsonSchema(schema, override), null, 2) +
    '\n\nIf evidence for a field is missing, use null / an empty array — never invent a value.'
  );
}
