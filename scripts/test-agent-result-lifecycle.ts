/**
 * Offline regression proof for invocation-scoped code-agent artifacts.
 *
 * No CLI or subscription is used: the three registered adapters temporarily
 * receive the same tiny contract implementation, while the real public
 * runCodeAgent() boundary owns preparation and dispatch.
 */
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from '../src/config.js';
import {
  getRuntimeById,
  runCodeAgent,
} from '../src/agents/runtime.js';
import {
  artifactProducedDuringInvocation,
  associateInvocationWithError,
  invocationFromError,
  prepareCodeAgentInvocation,
  readAndValidateResult,
} from '../src/agents/result.js';
import type {
  AgentRuntime,
  AgentRuntimeId,
  CodeAgentInvocationContext,
} from '../src/agents/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.AGENT_EXECUTION_MODE = 'local-development';
const ResultSchema = z.object({ ok: z.boolean(), note: z.string() });
const validResult = JSON.stringify({ ok: true, note: 'current invocation' });
let passed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

async function withRuntimeCodeAgent(
  runtimeId: AgentRuntimeId,
  implementation: AgentRuntime['codeAgent'],
  fn: () => Promise<void>,
): Promise<void> {
  const runtime = getRuntimeById(runtimeId);
  const originalCodeAgent = runtime.codeAgent;
  const originalRuntimeFor = config.agents.runtimeFor;
  runtime.codeAgent = implementation;
  config.agents.runtimeFor = () => runtimeId;
  try {
    await fn();
  } finally {
    runtime.codeAgent = originalCodeAgent;
    config.agents.runtimeFor = originalRuntimeFor;
  }
}

const tmp = await mkdtemp(path.join(tmpdir(), 'factory-agent-result-'));

try {
  for (const runtimeId of ['claude-code', 'codex', 'opencode'] as const) {
    await check(`${runtimeId} cannot accept a previous valid result`, async () => {
      const workspace = path.join(tmp, `old-${runtimeId}`);
      await mkdir(workspace, { recursive: true });
      const resultPath = path.join(workspace, 'result.json');
      await writeFile(resultPath, validResult);

      let observed: CodeAgentInvocationContext | undefined;
      const noWrite: AgentRuntime['codeAgent'] = async (opts, schema, invocation) => {
        observed = invocation;
        return readAndValidateResult(invocation.resultPath, opts.name, schema, invocation);
      };

      await withRuntimeCodeAgent(runtimeId, noWrite, async () => {
        let failure: unknown;
        try {
          await runCodeAgent(
            { name: `old-result:${runtimeId}`, cwd: workspace, prompt: 'do nothing', terminal: false },
            ResultSchema,
          );
        } catch (error) {
          failure = error;
        }
        assert.match(String((failure as Error | undefined)?.message), /did not write result\.json/);
        assert.equal(invocationFromError(failure), observed);
      });

      assert.equal(existsSync(resultPath), false);
      assert.ok(observed);
      assert.equal(Object.isFrozen(observed), true);
      assert.equal(observed.workspace, path.resolve(workspace));
    });
  }

  await check('a new valid result is accepted through the public boundary', async () => {
    const workspace = path.join(tmp, 'new-valid');
    const writesCurrentResult: AgentRuntime['codeAgent'] = async (opts, schema, invocation) => {
      await writeFile(invocation.resultPath, validResult);
      return readAndValidateResult(invocation.resultPath, opts.name, schema, invocation);
    };
    await withRuntimeCodeAgent('claude-code', writesCurrentResult, async () => {
      const result = await runCodeAgent(
        { name: 'new-valid', cwd: workspace, prompt: 'write result', terminal: false },
        ResultSchema,
      );
      assert.deepEqual(result, { ok: true, note: 'current invocation' });
    });
  });

  await check('a new result with an invalid schema remains a hard failure', async () => {
    const workspace = path.join(tmp, 'new-invalid');
    const writesInvalidResult: AgentRuntime['codeAgent'] = async (opts, schema, invocation) => {
      await writeFile(invocation.resultPath, JSON.stringify({ ok: 'yes', note: 7 }));
      return readAndValidateResult(invocation.resultPath, opts.name, schema, invocation);
    };
    await withRuntimeCodeAgent('codex', writesInvalidResult, async () => {
      await assert.rejects(
        runCodeAgent(
          { name: 'new-invalid', cwd: workspace, prompt: 'write invalid result', terminal: false },
          ResultSchema,
        ),
        /failed schema/,
      );
    });
  });

  await check('a valid file with pre-invocation metadata is rejected', async () => {
    const workspace = path.join(tmp, 'stale-metadata');
    const invocation = await prepareCodeAgentInvocation(workspace);
    await writeFile(invocation.resultPath, validResult);
    const old = new Date(invocation.notBeforeMs - 10_000);
    await utimes(invocation.resultPath, old, old);
    await assert.rejects(
      readAndValidateResult(invocation.resultPath, 'stale-metadata', ResultSchema, invocation),
      /predates invocation/,
    );
  });

  await check('pathname replacement during schema validation is rejected', async () => {
    const workspace = path.join(tmp, 'replace-race');
    const invocation = await prepareCodeAgentInvocation(workspace);
    const replacement = path.join(workspace, 'replacement.json');
    await writeFile(invocation.resultPath, validResult);
    await writeFile(replacement, JSON.stringify({ ok: true, note: 'replacement' }));

    const replacingSchema = ResultSchema.transform((value) => {
      renameSync(replacement, invocation.resultPath);
      return value;
    });
    await assert.rejects(
      readAndValidateResult(invocation.resultPath, 'replace-race', replacingSchema, invocation),
      /changed during validation/,
    );
  });

  await check('builder recovery rejects old out/ and accepts current out/', async () => {
    const workspace = path.join(tmp, 'reused-builder');
    const output = path.join(workspace, 'out', 'index.html');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, '<main>previous iteration</main>');
    const old = new Date(Date.now() - 10_000);
    await utimes(output, old, old);

    const invocation = await prepareCodeAgentInvocation(workspace);
    assert.equal(await artifactProducedDuringInvocation(output, invocation), false);

    await writeFile(output, '<main>current iteration</main>');
    assert.equal(await artifactProducedDuringInvocation(output, invocation), true);
  });

  await check('failed runs retain the exact invocation for recovery', async () => {
    const invocation = await prepareCodeAgentInvocation(path.join(tmp, 'error-association'));
    const original = new Error('agent failed');
    const associated = associateInvocationWithError(original, invocation);
    assert.equal(associated, original);
    assert.equal(invocationFromError(original), invocation);
  });

  await check('tmux and headless dispatch receive the same shared lease', async () => {
    const source = await readFile(path.join(ROOT, 'src/agents/runtime.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function runCodeAgent'));
    const preparedAt = body.indexOf('prepareCodeAgentInvocation(opts.cwd)');
    const selectedAt = body.indexOf("getRuntime(opts.kind ?? 'builder')");
    assert.ok(preparedAt >= 0 && selectedAt > preparedAt);
    assert.match(body, /remoteAgentTransport\.code\([\s\S]*?invocation/);
    assert.match(body, /executeCodeAgentLocally\(opts, resultSchema, invocation, runtime\)/);
    const localBody = source.slice(source.indexOf('export async function executeCodeAgentLocally'));
    assert.match(localBody, /runCodeAgentTmux\(opts, resultSchema, opts\.terminalSession, runtime, invocation\)/);
    assert.match(localBody, /runtime\.codeAgent\(opts, resultSchema, invocation\)/);
  });

  await check('result cleanup exists only at the shared boundary', async () => {
    for (const relative of [
      'src/agents/claudeCodeRuntime.ts',
      'src/agents/codexRuntime.ts',
      'src/agents/opencodeRuntime.ts',
      'src/agents/tmuxRuntime.ts',
      'src/build/workspace.ts',
    ]) {
      const source = await readFile(path.join(ROOT, relative), 'utf8');
      assert.doesNotMatch(source, /rm\([^\n]*result(?:Path|\.json)/, relative);
    }
  });

  console.log(`\n🧾 AGENT RESULT LIFECYCLE TESTS PASSED (${passed})`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
