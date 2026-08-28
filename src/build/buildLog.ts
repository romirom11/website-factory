/**
 * Live build log — an append-only ndjson trace of what the agent is doing.
 *
 * A build routinely runs for an hour. Until now the only thing the console could
 * say about it was «Виконується», which is indistinguishable from «зависло»
 * — Roman's words: "я хз шо там". This file is what makes the difference
 * visible: one JSON object per line, appended as the SDK streams messages, plus
 * stage markers written by the workers themselves.
 *
 * Design constraints, all of them load-bearing:
 *
 *  - **Never throws.** Writing telemetry must not be able to fail a build. Every
 *    entry point swallows its own errors (once, loudly, then silently).
 *  - **Append-only, line-oriented.** The reader tails it by byte offset; a
 *    partially-written last line is discarded rather than parsed. `appendFile`
 *    on a small line is atomic enough in practice for one writer.
 *  - **Bounded.** Summaries are truncated hard (see the SUMMARY_* limits) and the
 *    file is capped: a build that loops for 80 turns must not fill the volume.
 *  - **Shared volume.** The log is written by `factory-build` and read by the
 *    `factory` API process; both mount `sitesdata:/app/sites`, so a plain file
 *    inside the workspace is the whole transport. No DB row, no queue.
 *
 * Location: `sites/<businessId>/<projectId>/build-log.ndjson` — the workspace
 * directory itself, so it survives `collectWorkspaceGarbage` (which only removes
 * `node_modules`, `.next`, `out` and `references`) and a human can read it with
 * `docker compose cp` when the UI is not enough.
 */
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactSensitiveText } from '../lib/redaction.js';

/**
 * Deliberately re-derived rather than imported from `workspace.ts`.
 *
 * This module is imported by the API process and by an offline unit test;
 * `workspace.ts` pulls in object storage and the settings-backed config, which
 * would drag a database connection into both. The value is the same expression,
 * and `scripts/test-build-log.ts` asserts the two agree.
 */
const SITES_ROOT = path.resolve('sites');

/** One event as it lands on disk. Deliberately short keys: this file gets long. */
export interface BuildLogEvent {
  /** ISO timestamp. */
  t: string;
  /**
   * What kind of thing happened:
   *  - `stage`  — a pipeline milestone written by a worker (see `logStage`)
   *  - `text`   — the agent said something
   *  - `tool`   — the agent invoked a tool
   *  - `result` — that tool returned
   *  - `error`  — the run failed, or the runtime reported a problem
   */
  type: 'stage' | 'text' | 'tool' | 'result' | 'error';
  /** Human-readable one-liner. Already truncated; render it as-is. */
  summary: string;
  /** Tool name for `tool`/`result` events (`Edit`, `Bash`, …). */
  tool?: string;
  /** `ok` / `error` for `result` events. */
  status?: 'ok' | 'error';
  /** Which agent produced it — `site-builder`, `visual-qa`, … */
  agent?: string;
}

/** Assistant prose is the most verbose thing in the stream; 300 chars is a peek. */
const SUMMARY_TEXT_MAX = 300;
/** A shell command's first line is what identifies it; the rest is arguments. */
const SUMMARY_CMD_MAX = 120;
/** Tool results are for "did it work", not for reading output. */
const SUMMARY_RESULT_MAX = 120;
/**
 * Hard cap on the file. An 80-turn build writes a few hundred KB; anything past
 * this is a runaway loop, and the tail is the interesting half either way, so
 * further writes are dropped rather than rotated (rotation would break offsets
 * mid-poll, which is the one thing a live tail cannot survive).
 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * ONE live trace per business, for the WHOLE pipeline run (design → build →
 * QA → deploy). Keyed by business, not by project, because the design stage
 * runs before any project row exists — the old project-keyed file left the
 * card blind for the first 10-15 minutes («а де відображення процесу дівся?»,
 * Roman 2026-08-22) and split one run's history across two files. A new run
 * appends after the previous one; the UI slices at the run-start marker.
 * projectId belongs in the LINE (mentioned in summaries), never in the key.
 */
export function buildLogPath(businessId: string): string {
  return path.join(SITES_ROOT, businessId, 'pipeline-log.ndjson');
}

/** Cut a string to `max`, marking the cut so a truncated line never reads as complete. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Turn one SDK message into at most one log line.
 *
 * Returns `null` for everything we deliberately do not record — system init,
 * the final `result` envelope (the worker logs its own stage line for that),
 * thinking blocks, and any shape we do not recognise. Being generous with
 * `null` is what keeps this readable: the point is a story a person can follow,
 * not a transcript.
 *
 * Exported and pure so `scripts/test-build-log.ts` can exercise it against
 * captured message shapes without a runtime.
 */
export function summarizeSdkMessage(msg: unknown, agent?: string): BuildLogEvent | null {
  const m = msg as Record<string, any> | null;
  if (!m || typeof m !== 'object') return null;
  const t = new Date().toISOString();

  // A typed error on an assistant turn (rate_limit / overloaded / auth).
  if (m.type === 'assistant' && typeof m.error === 'string') {
    return { t, type: 'error', summary: clip(m.error, SUMMARY_RESULT_MAX), agent };
  }

  if (m.type === 'rate_limit_event') {
    const info = m.rate_limit_info as { status?: string; rateLimitType?: string } | undefined;
    if (info?.status !== 'rejected') return null; // allowed/warning events are noise
    return {
      t, type: 'error', agent,
      summary: `ліміт підписки вичерпано (${info.rateLimitType ?? 'невідомий тип'}) — чекаємо на скидання вікна`,
    };
  }

  if (m.type === 'assistant') {
    const blocks = m.message?.content;
    if (!Array.isArray(blocks)) return null;
    // One message can carry text AND a tool_use. The tool call is the more
    // informative half (it names a file or a command), so it wins.
    const toolUse = blocks.find((b: any) => b?.type === 'tool_use');
    if (toolUse) return toolEvent(toolUse, t, agent);
    const textBlock = blocks.find((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
    if (!textBlock) return null;
    return { t, type: 'text', summary: clip(textBlock.text, SUMMARY_TEXT_MAX), agent };
  }

  if (m.type === 'user') {
    const blocks = m.message?.content;
    if (!Array.isArray(blocks)) return null;
    const res = blocks.find((b: any) => b?.type === 'tool_result');
    if (!res) return null;
    const isError = res.is_error === true;
    return {
      t, type: 'result', status: isError ? 'error' : 'ok', agent,
      summary: clip(toolResultText(res.content), SUMMARY_RESULT_MAX) || (isError ? 'помилка' : 'ok'),
    };
  }

  return null;
}

/** `tool_result.content` is a string, or a list of blocks, or occasionally neither. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/**
 * The one argument per tool that tells a reader what is happening.
 *
 * A full input dump would put an entire file's contents on one line (Write),
 * which is both unreadable and the reason the size cap exists. So: the path for
 * file tools, the command for Bash, the pattern for search, and nothing for the
 * rest.
 */
export function toolEvent(block: unknown, t: string, agent?: string): BuildLogEvent {
  const b = block as Record<string, any>;
  const name = String(b?.name ?? 'tool');
  const input = (b?.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  let detail = '';
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      detail = shortPath(str(input.file_path) || str(input.path) || str(input.notebook_path));
      break;
    case 'Bash':
      detail = clip(str(input.command), SUMMARY_CMD_MAX);
      break;
    case 'Glob':
      detail = clip(str(input.pattern), SUMMARY_CMD_MAX);
      break;
    case 'Grep':
      detail = clip([str(input.pattern), shortPath(str(input.path))].filter(Boolean).join(' в '), SUMMARY_CMD_MAX);
      break;
    case 'WebSearch':
      // Search queries are outbound payloads. Even rejected tool calls can
      // appear in the SDK stream, so never persist the query itself.
      detail = 'контрольований пошук';
      break;
    case 'Skill':
      detail = clip(str(input.skill), SUMMARY_CMD_MAX);
      break;
    default:
      detail = '';
  }

  return { t, type: 'tool', tool: name, summary: detail, agent };
}

/**
 * Workspace-relative path, because the absolute one is
 * `/app/sites/<biz>/<id>/app/page.tsx` and only the last part carries meaning.
 * Falls back to the basename when the path does not look like a workspace path.
 */
export function shortPath(p: string): string {
  if (!p) return '';
  const marker = `${path.sep}sites${path.sep}`;
  const idx = p.indexOf(marker);
  if (idx >= 0) {
    // .../sites/<businessId>/<projectId>/<rest>
    const rest = p.slice(idx + marker.length).split(path.sep).slice(2).join('/');
    if (rest) return rest;
  }
  return p.split(path.sep).slice(-2).join('/');
}

/** Track loggers that already reported a write failure, so one broken path logs once. */
const warned = new Set<string>();

/**
 * Append one event. Never throws, never awaits anything the caller depends on.
 *
 * `logPath` being undefined is the normal case for agents that opted out (the
 * brand agent, the social finder) — those calls become no-ops with no branch at
 * the call site.
 */
export async function appendBuildLog(logPath: string | undefined, event: BuildLogEvent): Promise<void> {
  if (!logPath) return;
  try {
    const size = await stat(logPath).then((s) => s.size).catch(() => 0);
    if (size > MAX_LOG_BYTES) return;
    if (size === 0) await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify({
      ...event,
      summary: redactSensitiveText(event.summary),
    })}\n`, 'utf8');
  } catch (err) {
    if (!warned.has(logPath)) {
      warned.add(logPath);
      // eslint-disable-next-line no-console
      console.warn(`[build-log] cannot write ${logPath}: ${String(err).slice(0, 200)}`);
    }
  }
}

/**
 * Write a pipeline milestone — the spine the UI draws its timeline from.
 *
 * These are the lines a person actually reads: "збірка почалась", "ітерація 2",
 * "pnpm build", "деплой". The agent's own chatter is the texture between them.
 */
export async function logStage(
  logPath: string | undefined,
  summary: string,
  agent?: string,
): Promise<void> {
  await appendBuildLog(logPath, { t: new Date().toISOString(), type: 'stage', summary, agent });
}

export interface BuildLogTail {
  lines: BuildLogEvent[];
  /** Byte offset to pass as `after` next poll. */
  nextOffset: number;
  /** Seconds since the newest event, or null when the log is empty. */
  lastEventAgoSec: number | null;
  /** Total size on disk, so a caller can tell "no file" from "no new lines". */
  size: number;
}

/**
 * Read the log from a byte offset.
 *
 * Byte offsets rather than line numbers because the writer is appending while
 * we read: an offset is stable under concurrent appends, a line count is not.
 * A trailing partial line (the writer caught mid-append) is dropped and its
 * bytes are NOT consumed, so the next poll picks it up whole.
 *
 * `limit` caps how many lines come back; when the caller is far behind, the
 * TAIL is returned (the newest lines) and `nextOffset` still jumps to the end —
 * being behind by 900 lines means the middle of them is not worth transporting.
 */
export async function readBuildLog(
  logPath: string,
  after = 0,
  limit = 400,
): Promise<BuildLogTail> {
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return { lines: [], nextOffset: after, lastEventAgoSec: null, size: 0 };
  }

  // The file was truncated or replaced (a fresh build in the same workspace):
  // an offset past the end would return nothing forever, so restart from 0.
  const from = after > size ? 0 : Math.max(0, after);
  if (from === size) {
    return { lines: [], nextOffset: size, lastEventAgoSec: null, size };
  }

  const fh = await open(logPath, 'r');
  let raw: string;
  try {
    const length = size - from;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    raw = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }

  // Everything after the final newline is a line still being written.
  const lastNewline = raw.lastIndexOf('\n');
  const complete = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : '';
  const consumed = Buffer.byteLength(complete, 'utf8');

  const parsed: BuildLogEvent[] = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as BuildLogEvent;
      if (obj && typeof obj.t === 'string' && typeof obj.summary === 'string') parsed.push(obj);
    } catch {
      // A corrupted line is skipped, not fatal: this is telemetry.
    }
  }

  const lines = parsed.length > limit ? parsed.slice(-limit) : parsed;
  const newest = parsed[parsed.length - 1];
  const lastEventAgoSec = newest
    ? Math.max(0, Math.round((Date.now() - new Date(newest.t).getTime()) / 1000))
    : null;

  return { lines, nextOffset: from + consumed, lastEventAgoSec, size };
}
