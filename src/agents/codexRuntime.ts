/**
 * Codex CLI runtime adapter — alternative subscription runtime (SPEC §2.3).
 *
 * Auth is the ChatGPT subscription via `codex login` (token in $CODEX_HOME);
 * nothing pay-per-token, no OPENAI_API_KEY is ever passed. The credential is
 * read by the CLI itself from its own home directory, so `authEnv()` injects
 * nothing.
 *
 * structured(): `codex exec --output-schema <schema.json> --output-last-message <file>`
 *               in a read-only sandbox — the last agent message is the JSON.
 * codeAgent():  `codex exec --cd <workspace> --sandbox workspace-write`; the
 *               agent writes result.json, the same contract as every adapter.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { outputJsonSchema, extractJson, jsonOnlyInstruction } from './schema.js';
import { withAgentSlot } from './semaphore.js';
import { codeAgentEnv } from './sandbox.js';
import { withStructuredRetries } from './retry.js';
import { looksRateLimited, rateLimitedFromText } from './ratelimit.js';
import { effectiveModel } from './modelPolicy.js';
import { readAndValidateResult } from './result.js';
import { kickoffLine, PROMPT_FILE } from './tmuxRuntime.js';
import {
  RateLimitedError,
  RUNTIME_LABELS,
  type AgentRuntime,
  type CodeAgentInvocationContext,
  type CodeAgentOptions,
  type StructuredOptions,
  type TerminalLaunchSpec,
} from './types.js';

const DEFAULT_STRUCTURED_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CODE_TIMEOUT_MS = 60 * 60_000;

interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runCodex(args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Same allowlist as the Claude adapter: factory credentials (SMTP/IMAP/
    // Telegram/S3/DATABASE_URL) never reach an agent process, and no
    // pay-per-token API key is passed either.
    const env = codeAgentEnv();

    const child = spawn(config.agents.codexBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

function assertNotRateLimited(res: ExecResult): void {
  const blob = `${res.stdout}\n${res.stderr}`;
  if (looksRateLimited(blob)) {
    throw rateLimitedFromText('codex', blob.slice(-300));
  }
}

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  label: RUNTIME_LABELS['codex'],

  rateLimitFromText(text: string): RateLimitedError | null {
    return looksRateLimited(text) ? rateLimitedFromText(this.id, text) : null;
  },

  /** Codex reads its own credential from $CODEX_HOME; nothing to inject. */
  authEnv(): Record<string, string> {
    return {};
  },

  terminalLaunch(opts: CodeAgentOptions, _context: { settingsPath: string }): TerminalLaunchSpec {
    const args = [
      'exec',
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check',
      '--cd', opts.cwd,
    ];
    const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());
    if (model) args.push('--model', model);
    args.push(kickoffLine(PROMPT_FILE));
    return { command: config.agents.codexBin, args, needsKickoff: false, interactive: false };
  },

  async structured<T>(
    name: string,
    systemPrompt: string,
    userContent: string,
    schema: ZodType<T>,
    opts: StructuredOptions = {},
  ): Promise<T> {
    const retries = opts.retries ?? 2;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS;
    const scratch = await mkdtemp(path.join(tmpdir(), 'factory-codex-'));
    const schemaPath = path.join(scratch, 'schema.json');
    const lastMessagePath = path.join(scratch, 'last-message.txt');
    await writeFile(schemaPath, JSON.stringify(outputJsonSchema(schema, opts.outputJsonSchema), null, 2), 'utf8');

    const imageArgs = (opts.imagePaths ?? []).flatMap((p) => ['--image', p]);
    const prompt = `${systemPrompt}\n\n---\n\n${userContent}${jsonOnlyInstruction(schema, opts.outputJsonSchema)}`;
    const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());

    try {
      return await withStructuredRetries({
        name, runtime: this.id, retries,
        attempt: (attempt) => withAgentSlot(`structured:${name}`, async () => {
          const args = [
            'exec',
            '--sandbox', 'read-only',
            '--skip-git-repo-check',
            '--ephemeral',
            '--cd', opts.cwd ?? scratch,
            '--output-schema', schemaPath,
            '--output-last-message', lastMessagePath,
          ];
          if (model) args.push('--model', model);
          args.push(...imageArgs, prompt);

          const res = await runCodex(args, opts.cwd ?? scratch, timeoutMs);
          if (res.timedOut) throw new Error(`codex call "${name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
          assertNotRateLimited(res);
          if (res.code !== 0) {
            throw new Error(`codex exec exited ${res.code}: ${res.stderr.slice(-400) || res.stdout.slice(-400)}`);
          }

          const lastMessage = await readFile(lastMessagePath, 'utf8').catch(() => res.stdout);
          const candidate = extractJson(lastMessage);
          if (candidate === undefined) {
            throw new Error(`agent "${name}" returned no parseable JSON: ${lastMessage.slice(0, 300)}`);
          }
          const parsed = schema.safeParse(candidate);
          if (!parsed.success) {
            throw new Error(`schema validation failed: ${parsed.error.message.slice(0, 500)}`);
          }
          log.info('agent done', { name, runtime: this.id, attempt });
          return parsed.data;
        }),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  },

  async codeAgent<T>(
    opts: CodeAgentOptions,
    resultSchema: ZodType<T>,
    invocation: CodeAgentInvocationContext,
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;

    return withAgentSlot(`code:${opts.name}`, async () => {
      const prompt =
        `${opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n---\n\n` : ''}${opts.prompt}\n\n` +
        `MANDATORY FINAL STEP: write a file named result.json in the workspace root (${opts.cwd}) ` +
        `matching this JSON Schema, then stop:\n${JSON.stringify(outputJsonSchema(resultSchema, opts.outputJsonSchema), null, 2)}`;

      const args = [
        'exec',
        '--sandbox', 'workspace-write',
        '--skip-git-repo-check',
        '--cd', opts.cwd,
      ];
      const model = opts.model ?? effectiveModel(this.id, opts.heavy, config.agents.modelInputs());
      if (model) args.push('--model', model);
      args.push(prompt);

      const res = await runCodex(args, opts.cwd, timeoutMs);
      if (res.timedOut) throw new Error(`codex code agent "${opts.name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
      assertNotRateLimited(res);
      if (res.code !== 0) {
        throw new Error(`codex code agent "${opts.name}" exited ${res.code}: ${res.stderr.slice(-400)}`);
      }
      return readAndValidateResult(invocation.resultPath, opts.name, resultSchema, invocation);
    });
  },
};
