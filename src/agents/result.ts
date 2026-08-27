/**
 * The workspace artifact contract shared by EVERY adapter and transport.
 *
 * A code agent's only channel back into the pipeline is `result.json` in the
 * workspace root, validated against the caller's zod schema. Headless SDK
 * runs (Claude), CLI subprocess runs (Codex) and tmux terminal runs all read
 * their answer through this one function — which is what makes the transports
 * interchangeable: same file, same schema, same errors.
 */
import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { extractJson } from './schema.js';
import { AgentSchemaError, type CodeAgentInvocationContext } from './types.js';

/** Filesystems may expose millisecond timestamps with small rounding loss. */
const TIMESTAMP_TOLERANCE_NS = 2_000_000n;

/** Invocation metadata is attached without changing the original error type. */
const invocationByError = new WeakMap<object, CodeAgentInvocationContext>();

/** Where an agent of `name` must have written its answer inside `workspace`. */
export function resultPathIn(workspace: string): string {
  return path.join(workspace, 'result.json');
}

/**
 * Start the single result-artifact lease shared by every transport.
 *
 * This must run before runtime and tmux/headless selection. Deleting the old
 * file anywhere deeper would leave another transport able to accept it.
 */
export async function prepareCodeAgentInvocation(
  workspace: string,
): Promise<CodeAgentInvocationContext> {
  const resolvedWorkspace = path.resolve(workspace);
  const resultPath = resultPathIn(resolvedWorkspace);
  const notBeforeMs = Date.now();
  await mkdir(resolvedWorkspace, { recursive: true });
  await rm(resultPath, { force: true });

  return Object.freeze({
    invocationId: randomUUID(),
    workspace: resolvedWorkspace,
    resultPath,
    notBeforeMs,
  });
}

/** Preserve errors such as RateLimitedError while making recovery lease-aware. */
export function associateInvocationWithError(
  error: unknown,
  invocation: CodeAgentInvocationContext,
): Error {
  const associated = error instanceof Error ? error : new Error(String(error));
  invocationByError.set(associated, invocation);
  return associated;
}

/** Return the trusted lease for a failed run, if the failure crossed our boundary. */
export function invocationFromError(error: unknown): CodeAgentInvocationContext | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? invocationByError.get(error as object)
    : undefined;
}

function sameOpenedFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isFresh(mtimeNs: bigint, invocation: CodeAgentInvocationContext): boolean {
  const leaseNs = BigInt(Math.trunc(invocation.notBeforeMs * 1_000_000));
  return mtimeNs + TIMESTAMP_TOLERANCE_NS >= leaseNs;
}

function assertInvocationPath(resultPath: string, invocation: CodeAgentInvocationContext): void {
  if (path.resolve(resultPath) !== invocation.resultPath) {
    throw new AgentSchemaError(
      `result artifact path does not belong to invocation ${invocation.invocationId}`,
    );
  }
}

/**
 * Does a recoverable deliverable belong to this invocation?
 *
 * Builder recovery still verifies the output independently; this predicate
 * only prevents an untouched `out/index.html` in a reused workspace from
 * impersonating work done by the failed current agent.
 */
export async function artifactProducedDuringInvocation(
  artifactPath: string,
  invocation: CodeAgentInvocationContext,
): Promise<boolean> {
  try {
    const metadata = await lstat(artifactPath, { bigint: true });
    return metadata.isFile() && !metadata.isSymbolicLink()
      && isFresh(metadata.mtimeNs, invocation);
  } catch {
    return false;
  }
}

/**
 * Read and validate the current invocation's result artifact.
 *
 * The file is opened without following symlinks and its identity is checked
 * before and after parse/schema validation. That closes the pathname-replace
 * race as well as in-place mutation while validation is in progress.
 */
export async function readAndValidateResult<T>(
  resultPath: string,
  agentName: string,
  resultSchema: ZodType<T>,
  invocation: CodeAgentInvocationContext,
): Promise<T> {
  assertInvocationPath(resultPath, invocation);

  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(resultPath, { bigint: true });
  } catch {
    throw new AgentSchemaError(`code agent "${agentName}" did not write result.json at ${resultPath}`);
  }

  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new AgentSchemaError(`code agent "${agentName}" result.json is not a regular file`);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new AgentSchemaError(`code agent "${agentName}" result.json could not be opened safely`);
  }

  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile()
      || pathBefore.dev !== openedBefore.dev
      || pathBefore.ino !== openedBefore.ino) {
      throw new AgentSchemaError(`code agent "${agentName}" result.json changed while opening`);
    }

    if (!isFresh(openedBefore.mtimeNs, invocation)) {
      throw new AgentSchemaError(
        `code agent "${agentName}" result.json predates invocation ${invocation.invocationId}`,
      );
    }

    const raw = await handle.readFile('utf8');
    const candidate = extractJson(raw);
    if (candidate === undefined) {
      throw new AgentSchemaError(`code agent "${agentName}" wrote unparseable result.json`);
    }
    const parsed = resultSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AgentSchemaError(
        `code agent "${agentName}" result.json failed schema: ${parsed.error.message.slice(0, 400)}`,
      );
    }

    const [openedAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(resultPath, { bigint: true }),
    ]);
    if (!pathAfter.isFile()
      || !sameOpenedFile(openedBefore, openedAfter)
      || openedAfter.dev !== pathAfter.dev
      || openedAfter.ino !== pathAfter.ino
      || openedAfter.size !== pathAfter.size
      || openedAfter.mtimeNs !== pathAfter.mtimeNs
      || openedAfter.ctimeNs !== pathAfter.ctimeNs) {
      throw new AgentSchemaError(`code agent "${agentName}" result.json changed during validation`);
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof AgentSchemaError) throw error;
    throw new AgentSchemaError(
      `code agent "${agentName}" result.json changed during validation`,
    );
  } finally {
    await handle.close();
  }
}
