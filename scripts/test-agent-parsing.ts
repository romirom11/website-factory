/**
 * Pure-function tests for the agent runtime: JSON extraction, zod->JSON Schema,
 * rate-limit detection and the concurrency semaphore. No model calls, no network.
 *
 *   pnpm tsx scripts/test-agent-parsing.ts
 */
import { extractJson, zodToJsonSchema } from '../src/agents/schema.js';
import { looksRateLimited } from '../src/agents/ratelimit.js';
import { effectiveModel, effectiveModels } from '../src/agents/modelPolicy.js';
import { withAgentSlot, agentSlotStats } from '../src/agents/semaphore.js';
import {
  AgentAuthError, RateLimitedError, isRateLimitedError, RUNTIME_LABELS,
} from '../src/agents/types.js';
import { enabledOpenCodeProviderIds, openCodeCatalog, runtimeDomains } from '../src/runner/egressRegistry.js';
import { brokerProviderConfig, OPENCODE_BROKER_PLACEHOLDER } from '../src/runner/providerBroker.js';
// OpenCode NDJSON fixtures captured live on 2026-08-24 (CLI 1.18.x).
import {
  parseOpencodeEvents, lastTextEvent, allText, usageFromEvents, errorFromEvents,
} from '../src/agents/opencodeRuntime.js';
import { getRuntime, getRuntimeById } from '../src/agents/runtime.js';
import { config } from '../src/config.js';
import { primeSettings } from '../src/lib/settings.js';
import { z } from 'zod';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`✅ ${label}`);
  else { failures++; console.error(`❌ ${label}`, detail ?? ''); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── extractJson ─────────────────────────────────────────────────────────────
check('plain object', eq(extractJson('{"a":1}'), { a: 1 }));
check('fenced json', eq(extractJson('```json\n{"a":1}\n```'), { a: 1 }));
check('bare fence', eq(extractJson('```\n{"a":1}\n```'), { a: 1 }));
check('prose around json', eq(extractJson('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 }));
check('top-level array', eq(extractJson('[1,2,3]'), [1, 2, 3]));
check('braces inside strings', eq(extractJson('{"a":"}{ not a brace"}'), { a: '}{ not a brace' }));
check('nested objects', eq(extractJson('text {"a":{"b":[1,{"c":2}]}} tail'), { a: { b: [1, { c: 2 }] } }));
check('escaped quote in string', eq(extractJson('{"a":"say \\"hi\\""}'), { a: 'say "hi"' }));
check('no json -> undefined', extractJson('there is no json here') === undefined);
check('empty -> undefined', extractJson('   ') === undefined);

// ── zodToJsonSchema ─────────────────────────────────────────────────────────
const Schema = z.object({
  name: z.string(),
  year: z.number().nullable(),
  tags: z.array(z.string()),
  kind: z.enum(['a', 'b']),
  note: z.string().optional(),
});
const js = zodToJsonSchema(Schema) as any;
check('object type', js.type === 'object');
check('required excludes optional', eq(js.required.sort(), ['kind', 'name', 'tags', 'year']), js.required);
check('nullable -> anyOf', eq(js.properties.year, { anyOf: [{ type: 'number' }, { type: 'null' }] }));
check('array items', eq(js.properties.tags, { type: 'array', items: { type: 'string' } }));
check('enum values', eq(js.properties.kind, { type: 'string', enum: ['a', 'b'] }));
check('additionalProperties false', js.additionalProperties === false);

// ── rate limit detection (shared signatures) ────────────────────────────────
check('detects "rate limit"', looksRateLimited('Error: rate limit exceeded'));
check('detects "usage limit"', looksRateLimited("You've hit your usage limit"));
check('detects 429', looksRateLimited('HTTP 429 Too Many Requests'));
check('detects "try again later" (the union of both former lists)',
  looksRateLimited('Please try again later'), 'pattern missing from the shared list');
check('ignores normal output', !looksRateLimited('Created hello.txt successfully'));

// ── registry ────────────────────────────────────────────────────────────────
for (const id of ['claude-code', 'codex', 'opencode'] as const) {
  check(`runtime "${id}" registered with a label`, getRuntimeById(id).label === RUNTIME_LABELS[id]);
}

// ── opencode NDJSON stream (fixtures captured live) ──────────────────────────
{
  const pongStream = [
    '{"type":"step_start","timestamp":1787561034633,"sessionID":"ses_probe","part":{"type":"step-start"}}',
    '{"type":"text","timestamp":1787561035000,"sessionID":"ses_probe","part":{"type":"text","text":"{\\"pong\\": true}"}}',
    '{"type":"step_finish","timestamp":1787561036000,"sessionID":"ses_probe","part":{"type":"step-finish","reason":"stop","tokens":{"input":16517,"output":17},"cost":0}}',
  ].join('\n');
  const events = parseOpencodeEvents(pongStream);
  check('opencode: parses the three event kinds', events.length === 3, events.length);
  check('opencode: last text is the final answer', lastTextEvent(events).includes('pong'));
  const usage = usageFromEvents(events);
  check('opencode: usage counts one finished step', usage.numTurns === 1);
  check('opencode: usage carries cost when reported', usage.costUsd === 0);

  // The CLI interleaves human-readable lines (auto-rejected asks) with JSON.
  const noisy = '!\x1b[1m permission requested: bash (echo hi); auto-rejecting\n' + pongStream;
  check('opencode: skips non-JSON noise lines between events',
    parseOpencodeEvents(noisy).length === 3);

  const paymentRequired = parseOpencodeEvents(JSON.stringify({
    type: 'error', timestamp: 1787560590247, sessionID: 'ses_x',
    error: { name: 'APIError', data: {
      message: 'Payment Required: unable to verify your membership benefits at this time.',
      statusCode: 402,
    } },
  }));
  const limited = errorFromEvents(paymentRequired);
  check('opencode: 402 membership wall pauses the job instead of failing it',
    limited instanceof RateLimitedError && limited.runtime === 'opencode');

  const plainError = parseOpencodeEvents(JSON.stringify({
    type: 'error', sessionID: 'ses_x',
    error: { name: 'APIError', data: { message: 'model overloaded, try later', statusCode: 500 } },
  }));
  const ordinary = errorFromEvents(plainError);
  check('opencode: an ordinary API error stays an ordinary error',
    ordinary instanceof Error && !(ordinary instanceof RateLimitedError));

  check('opencode: clean stream yields no error', errorFromEvents(parseOpencodeEvents(pongStream)) === null);

  // A rejected key is a human's problem (reconnect), never a subscription window.
  for (const statusCode of [401, 403]) {
    const rejected = errorFromEvents(parseOpencodeEvents(JSON.stringify({
      type: 'error', error: { name: 'APIError', data: { message: 'Invalid Authentication', statusCode } },
    })));
    check(`opencode: ${statusCode} becomes NEEDS_HUMAN, not a pause`,
      rejected instanceof AgentAuthError && rejected.code === 'NEEDS_HUMAN' && !isRateLimitedError(rejected)
        && /Акаунти/.test(rejected.message));
  }
  const throttled = errorFromEvents(parseOpencodeEvents(JSON.stringify({
    type: 'error', error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429 } },
  })));
  check('opencode: 429 still pauses the job', throttled instanceof RateLimitedError);
  check('opencode: capability detects "payment required" in free text',
    getRuntimeById('opencode').rateLimitFromText('Payment Required: quota') !== null);
}

// ── settings → selected runtime CLI ────────────────────────────────────────
// The model fields in /settings are provider-neutral. The policy that maps them
// onto a runtime's CLI is `effectiveModels`: the default runtime passes the raw
// values; every other runtime treats "came from the registry default" as unset,
// and lets a saved normal model cover the heavy tier.
const savedEnv = new Map([
  ['AGENT_RUNTIME', process.env.AGENT_RUNTIME],
  ['AGENT_RUNTIME_DESIGN', process.env.AGENT_RUNTIME_DESIGN],
  ['AGENT_MODEL', process.env.AGENT_MODEL],
  ['AGENT_MODEL_HEAVY', process.env.AGENT_MODEL_HEAVY],
]);
delete process.env.AGENT_RUNTIME;
process.env.AGENT_RUNTIME_DESIGN = 'claude-code';
delete process.env.AGENT_MODEL;
delete process.env.AGENT_MODEL_HEAVY;
primeSettings(new Map([
  ['AGENT_RUNTIME', 'codex'],
  ['AGENT_MODEL', 'gpt-5.6-terra'],
  ['AGENT_MODEL_HEAVY', 'gpt-5.6-sol'],
]));

check('global UI runtime applies to design despite legacy stage env',
  config.agents.runtimeFor('design') === 'codex', config.agents.runtimeFor('design'));
check('every agent kind resolves to the runtime selected in the UI',
  (['enrichment', 'qa', 'content', 'design', 'outreach', 'builder', 'visual-critique'] as const)
    .every((kind) => getRuntime(kind).id === 'codex'));
check('Codex normal call receives AGENT_MODEL',
  effectiveModel('codex', false, config.agents.modelInputs()) === 'gpt-5.6-terra');
check('Codex heavy call receives AGENT_MODEL_HEAVY',
  effectiveModel('codex', true, config.agents.modelInputs()) === 'gpt-5.6-sol');

primeSettings(new Map([
  ['AGENT_RUNTIME', 'codex'],
  ['AGENT_MODEL', 'gpt-5.6-terra'],
]));
check('Codex heavy calls inherit the normal model when heavy is unset',
  effectiveModels('codex', config.agents.modelInputs()).heavy === 'gpt-5.6-terra');

primeSettings(new Map([['AGENT_RUNTIME', 'codex']]));
{
  const m = effectiveModels('codex', config.agents.modelInputs());
  check('untouched Claude defaults are never passed to Codex',
    m.normal === '' && m.heavy === '', m);
}
{
  const m = effectiveModels('claude-code', config.agents.modelInputs());
  check('Claude still receives its registry defaults when nothing is saved',
    m.normal === 'claude-sonnet-5' && m.heavy === 'claude-opus-5', m);
}
{
  const m = effectiveModels('opencode', config.agents.modelInputs());
  check('OpenCode also keeps its own default when nothing is saved',
    m.normal === '' && m.heavy === '', m);
}

primeSettings(new Map([
  ['AGENT_RUNTIME', 'opencode'],
  ['AGENT_MODEL', 'kimi-for-coding/k3'],
]));
{
  const m = effectiveModels('opencode', config.agents.modelInputs());
  check('OpenCode: a saved normal model covers both tiers',
    m.normal === 'kimi-for-coding/k3' && m.heavy === 'kimi-for-coding/k3', m);

  primeSettings(new Map([
    ['AGENT_RUNTIME', 'opencode'],
    ['AGENT_MODEL', 'kimi-for-coding/k3'],
    ['AGENT_MODEL_HEAVY', 'moonshotai/kimi-k2.7-code'],
  ]));
  const full = effectiveModel('opencode', true, config.agents.modelInputs());
  check('OpenCode: an explicit heavy model wins for the heavy tier',
    full === 'moonshotai/kimi-k2.7-code');
}

for (const [key, value] of savedEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
primeSettings(new Map());

const rl = new RateLimitedError('window exhausted', {
  retryAfterMs: 900_000, rateLimitType: 'five_hour', runtime: 'codex',
});
check('RateLimitedError code', rl.code === 'RATE_LIMITED');
check('isRateLimitedError true', isRateLimitedError(rl));
check('isRateLimitedError false for plain', !isRateLimitedError(new Error('boom')));
check('retryAfterMs preserved', rl.retryAfterMs === 900_000);
check('rate-limit runtime preserved', rl.runtime === 'codex');

// ── egress registry + broker config (one source for proxy, DNS, sandbox, UI) ─
{
  const catalog = openCodeCatalog();
  check('registry: GLM coding plan is routable', catalog.get('zai-coding-plan')?.api === 'https://api.z.ai/api/coding/paas/v4');
  check('registry: SDK-default providers carry their base URL', catalog.get('anthropic')?.api === 'https://api.anthropic.com/v1');
  check('registry: package domains come from runtime-domains.txt', eq(runtimeDomains('package'), ['npmjs.org', 'yarnpkg.com']));
  check('registry: OPENCODE_PROVIDERS is parsed and validated',
    eq(enabledOpenCodeProviderIds({ OPENCODE_PROVIDERS: 'zai-coding-plan, kimi-for-coding,zai-coding-plan' }), ['zai-coding-plan', 'kimi-for-coding']));
  let rejected = false;
  try { enabledOpenCodeProviderIds({ OPENCODE_PROVIDERS: 'not-a-provider' }); } catch { rejected = true; }
  check('registry: an unknown provider id is rejected loudly', rejected);
  const fragment = brokerProviderConfig(8792, [catalog.get('zai-coding-plan')!]);
  check('broker config routes the provider to loopback with a placeholder key',
    eq(fragment, { 'zai-coding-plan': { options: { baseURL: 'http://127.0.0.1:8792/zai-coding-plan', apiKey: OPENCODE_BROKER_PLACEHOLDER } } }),
    fragment);
}

// ── semaphore (AGENT_CONCURRENCY defaults to 1) ─────────────────────────────
const order: string[] = [];
let maxObserved = 0;
const task = (id: string) => withAgentSlot(id, async () => {
  maxObserved = Math.max(maxObserved, agentSlotStats().active);
  order.push(`start:${id}`);
  await new Promise((r) => setTimeout(r, 30));
  order.push(`end:${id}`);
});
await Promise.all([task('a'), task('b'), task('c')]);
check('semaphore serializes at limit 1', maxObserved === 1, { maxObserved });
check('no interleaving', eq(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']), order);
check('slots released', agentSlotStats().active === 0 && agentSlotStats().waiting === 0);

// a throwing task must still release its slot
await withAgentSlot('boom', async () => { throw new Error('x'); }).catch(() => {});
check('slot released after throw', agentSlotStats().active === 0);

console.log(failures === 0 ? '\n🧪 AGENT PARSING TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
