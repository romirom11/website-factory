/**
 * Offline tests for the live build log (`src/build/buildLog.ts`).
 *
 * No docker, no database, no network — this suite runs on a laptop with the
 * stack down, which is the point: the log is telemetry for a build that takes
 * an hour, and the code that summarises it has no other way to be exercised
 * without spending an hour and a subscription window.
 *
 * The two things most likely to break here, and therefore what is tested hardest:
 *
 *  1. **Summarising SDK messages.** The shapes come from
 *     `@anthropic-ai/claude-agent-sdk` and are nested three deep
 *     (`message.content[].input.file_path`). A wrong guess produces empty lines
 *     rather than an error, so every shape is asserted against a fixture built
 *     to match what `collectRun` actually iterates over.
 *  2. **Tail-by-offset.** The reader polls a file another process is appending
 *     to. A partial final line must not be parsed and must not be consumed, or
 *     the UI shows garbage once and then silently skips a real event.
 *
 *   pnpm tsx scripts/test-build-log.ts
 */
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendBuildLog, buildLogPath, clip, logStage, readBuildLog, shortPath,
  summarizeSdkMessage, type BuildLogEvent,
} from '../src/build/buildLog.js';

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tmp = await mkdtemp(path.join(tmpdir(), 'factory-buildlog-'));

// ─── helpers ─────────────────────────────────────────────────────────────────

console.log('\nTruncation and paths');
{
  check('clip leaves a short string alone', clip('pnpm build', 120) === 'pnpm build');
  check('clip collapses whitespace', clip('a\n  b\tc', 120) === 'a b c');

  const long = 'x'.repeat(500);
  const clipped = clip(long, 300);
  check('clip cuts to the limit', clipped.length === 300, `${clipped.length}`);
  check('a cut string is marked as cut', clipped.endsWith('…'));

  check('shortPath strips the workspace prefix',
    shortPath('/app/sites/biz-1/42/app/page.tsx') === 'app/page.tsx',
    shortPath('/app/sites/biz-1/42/app/page.tsx'));
  check('shortPath handles a nested file',
    shortPath('/app/sites/biz-1/42/components/Hero.tsx') === 'components/Hero.tsx');
  check('a non-workspace path degrades to the last two segments',
    shortPath('/etc/nginx/nginx.conf') === 'nginx/nginx.conf');
  check('shortPath tolerates an empty path', shortPath('') === '');
}

// ─── SDK message shapes ──────────────────────────────────────────────────────
//
// These fixtures mirror what the SDK yields from `query()`; the summariser
// reaches three levels into them, so a shape drift here is exactly the failure
// this file exists to catch.

console.log('\nSummarising SDK messages');
{
  const assistantText = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I will start by reading BUILD-TASK.md to understand the contract.' }] },
  };
  const ev = summarizeSdkMessage(assistantText, 'site-builder');
  check('assistant text becomes a text event', ev?.type === 'text');
  check('assistant text is recorded verbatim (short enough to fit)',
    ev?.summary.startsWith('I will start by reading'), ev?.summary);
  check('the agent name rides along', ev?.agent === 'site-builder');
  check('the timestamp is an ISO string', !!ev && !Number.isNaN(new Date(ev.t).getTime()));

  const longText = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'y'.repeat(900) }] },
  };
  check('long assistant text is clipped to 300',
    summarizeSdkMessage(longText)?.summary.length === 300);

  const edit = {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/app/sites/b/7/app/page.tsx' } }],
    },
  };
  const editEv = summarizeSdkMessage(edit);
  check('Edit becomes a tool event', editEv?.type === 'tool' && editEv.tool === 'Edit');
  check('Edit carries the workspace-relative path', editEv?.summary === 'app/page.tsx', editEv?.summary);

  const bash = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm build 2>&1 | tail -50' } }] },
  };
  const bashEv = summarizeSdkMessage(bash);
  check('Bash carries the command', bashEv?.summary === 'pnpm build 2>&1 | tail -50', bashEv?.summary);

  const longBash = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${'z'.repeat(400)}` } }] },
  };
  check('a long command is clipped to 120',
    summarizeSdkMessage(longBash)?.summary.length === 120,
    String(summarizeSdkMessage(longBash)?.summary.length));

  // A single assistant message can carry prose AND a tool call. The tool call
  // is the more informative half and must win, or a build that is writing files
  // shows up as a wall of commentary.
  const both = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Now I will write the hero component.' },
        { type: 'tool_use', name: 'Write', input: { file_path: '/app/sites/b/7/components/Hero.tsx' } },
      ],
    },
  };
  const bothEv = summarizeSdkMessage(both);
  check('a message with text AND a tool_use logs the tool',
    bothEv?.type === 'tool' && bothEv.tool === 'Write', JSON.stringify(bothEv));

  const okResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'Applied 1 edit to app/page.tsx' }] },
  };
  const okEv = summarizeSdkMessage(okResult);
  check('a tool result becomes a result event', okEv?.type === 'result' && okEv.status === 'ok');

  const errResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', is_error: true, content: 'Error: ENOENT no such file' }] },
  };
  const errEv = summarizeSdkMessage(errResult);
  check('a failing tool result is marked as an error', errEv?.status === 'error');
  check('the failure text is kept', errEv?.summary.includes('ENOENT'), errEv?.summary);

  // `tool_result.content` is sometimes a list of blocks rather than a string.
  const blockResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'File created' }] }] },
  };
  check('a block-shaped tool result is read',
    summarizeSdkMessage(blockResult)?.summary === 'File created',
    summarizeSdkMessage(blockResult)?.summary);

  const typedError = { type: 'assistant', error: 'rate_limit' };
  check('a typed assistant error becomes an error event',
    summarizeSdkMessage(typedError)?.type === 'error');

  const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } };
  const rlEv = summarizeSdkMessage(rejected);
  check('a rejected rate-limit event is logged', rlEv?.type === 'error');
  check('the rate-limit line names the window type',
    rlEv?.summary.includes('five_hour'), rlEv?.summary);

  const allowed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } };
  check('a non-rejected rate-limit event is dropped as noise',
    summarizeSdkMessage(allowed) === null);

  // Everything deliberately unrecorded. Being generous with null is what keeps
  // the panel readable, so it is asserted rather than left to chance.
  check('the system init message is dropped', summarizeSdkMessage({ type: 'system', subtype: 'init' }) === null);
  check('the final result envelope is dropped',
    summarizeSdkMessage({ type: 'result', subtype: 'success', result: 'done' }) === null);
  check('an empty assistant message is dropped',
    summarizeSdkMessage({ type: 'assistant', message: { content: [] } }) === null);
  check('whitespace-only assistant text is dropped',
    summarizeSdkMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }) === null);
  check('null is dropped', summarizeSdkMessage(null) === null);
  check('a string is dropped', summarizeSdkMessage('nonsense') === null);

  // An unknown tool must still produce a line: a new SDK tool should degrade to
  // something readable, never vanish from the trace.
  const unknown = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'SomeNewTool', input: { whatever: 1 } }] },
  };
  const unknownEv = summarizeSdkMessage(unknown);
  check('an unknown tool still logs, named', unknownEv?.type === 'tool' && unknownEv.tool === 'SomeNewTool');
}

// ─── writing ─────────────────────────────────────────────────────────────────

console.log('\nWriting');
{
  const p = path.join(tmp, 'nested', 'build-log.ndjson');
  await logStage(p, 'Збірка почалась', 'site-builder');
  await logStage(p, 'Агент почав працювати', 'site-builder');
  const raw = await readFile(p, 'utf8');
  check('the directory is created on demand', raw.length > 0);
  check('one line per event', raw.trimEnd().split('\n').length === 2);
  check('each line is valid JSON',
    raw.trimEnd().split('\n').every((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    }));
  check('stage events are typed as stages',
    (JSON.parse(raw.split('\n')[0]!) as BuildLogEvent).type === 'stage');

  // The invariant that matters most: telemetry cannot break a build.
  let threw = false;
  try {
    // A path under a FILE is unopenable on every platform we run on.
    const blocked = path.join(p, 'impossible', 'build-log.ndjson');
    await appendBuildLog(blocked, { t: new Date().toISOString(), type: 'stage', summary: 'x' });
  } catch {
    threw = true;
  }
  check('an unwritable log never throws', !threw);

  let undefThrew = false;
  try {
    await appendBuildLog(undefined, { t: new Date().toISOString(), type: 'stage', summary: 'x' });
    await logStage(undefined, 'no log configured');
  } catch {
    undefThrew = true;
  }
  check('an absent log path is a silent no-op', !undefThrew);
}

// ─── tail by offset ──────────────────────────────────────────────────────────

console.log('\nReading by offset');
{
  const p = path.join(tmp, 'tail.ndjson');
  const line = (summary: string) =>
    `${JSON.stringify({ t: new Date().toISOString(), type: 'stage', summary })}\n`;

  await writeFile(p, line('перша') + line('друга'));
  const first = await readBuildLog(p, 0);
  check('a fresh read returns everything', first.lines.length === 2);
  check('nextOffset lands at the end of the file', first.nextOffset === first.size,
    `${first.nextOffset} vs ${first.size}`);
  check('lastEventAgoSec is a number when there are lines', typeof first.lastEventAgoSec === 'number');

  const nothingNew = await readBuildLog(p, first.nextOffset);
  check('polling with no new data returns no lines', nothingNew.lines.length === 0);
  check('and holds the offset', nothingNew.nextOffset === first.nextOffset);

  await appendFile(p, line('третя'));
  const incremental = await readBuildLog(p, first.nextOffset);
  check('only the new line comes back', incremental.lines.length === 1);
  check('and it is the right one', incremental.lines[0]?.summary === 'третя');

  // The writer caught mid-append. This is the case that silently loses an event
  // if the reader consumes the bytes of a line it could not parse.
  const beforePartial = incremental.nextOffset;
  await appendFile(p, '{"t":"2026-08-22T10:00:00.000Z","type":"stage","sum');
  const partial = await readBuildLog(p, beforePartial);
  check('a half-written line yields no event', partial.lines.length === 0);
  check('and its bytes are NOT consumed', partial.nextOffset === beforePartial,
    `${partial.nextOffset} vs ${beforePartial}`);

  await appendFile(p, 'mary":"четверта"}\n');
  const completed = await readBuildLog(p, beforePartial);
  check('once complete, the line is delivered whole',
    completed.lines.length === 1 && completed.lines[0]?.summary === 'четверта',
    JSON.stringify(completed.lines));

  // A corrupt line is telemetry damage, not a reason to fail a poll.
  await appendFile(p, 'not json at all\n' + line('пʼята'));
  const afterGarbage = await readBuildLog(p, completed.nextOffset);
  check('a corrupt line is skipped, the good one survives',
    afterGarbage.lines.length === 1 && afterGarbage.lines[0]?.summary === 'пʼята',
    JSON.stringify(afterGarbage.lines));

  // A fresh build in the same workspace truncates the file. An offset past the
  // end would otherwise return nothing forever.
  await writeFile(p, line('новий прогін'));
  const afterTruncate = await readBuildLog(p, 999_999);
  check('an offset past the end restarts from the beginning',
    afterTruncate.lines.length === 1 && afterTruncate.lines[0]?.summary === 'новий прогін');

  const missing = await readBuildLog(path.join(tmp, 'does-not-exist.ndjson'), 0);
  check('a missing log reads as empty, not as an error', missing.lines.length === 0 && missing.size === 0);
  check('a missing log reports no last event', missing.lastEventAgoSec === null);

  // Far behind: the tail is what matters, and the offset must still jump to the
  // end or the reader stays permanently behind.
  const many = Array.from({ length: 50 }, (_, i) => line(`подія ${i}`)).join('');
  await writeFile(p, many);
  const limited = await readBuildLog(p, 0, 10);
  check('the limit caps how many lines come back', limited.lines.length === 10);
  check('and it is the TAIL that is kept',
    limited.lines[9]?.summary === 'подія 49', limited.lines[9]?.summary);
  check('the offset still jumps to the end', limited.nextOffset === limited.size);
}

// ─── plumbing the workers depend on ──────────────────────────────────────────
//
// The business-scoped log's location is a contract between four processes:
// three workers write it, the API reads it, and project workspace cleanup must
// not delete it. None of that
// is expressible as a unit call, so it is asserted against the source.

console.log('\nWorkspace plumbing');
{
  const p = buildLogPath('e2e-fixture-biz');
  check('the log lives at the business root outside disposable project workspaces',
    p.endsWith(path.join('sites', 'e2e-fixture-biz', 'pipeline-log.ndjson')), p);

  const workspaceSrc = await readFile(path.resolve('src/build/workspace.ts'), 'utf8');
  check('SITES_ROOT is still `path.resolve(\'sites\')` in workspace.ts',
    /export const SITES_ROOT = path\.resolve\('sites'\)/.test(workspaceSrc));
  check('buildLog.ts derives the same root',
    /const SITES_ROOT = path\.resolve\('sites'\)/.test(
      await readFile(path.resolve('src/build/buildLog.ts'), 'utf8')));

  // A fresh build `rm -rf`s the workspace. The log of the run in progress has
  // already been opened by then, so it must be carried across the wipe.
  check('a fresh workspace preserves the build log',
    /const logFile = path\.join\(dir, 'build-log\.ndjson'\)/.test(workspaceSrc)
    && /if \(carried\) await writeFile\(logFile, carried\)/.test(workspaceSrc));

  // GC after a deploy removes build output. The log is a record of the run and
  // must not be in that list.
  check('workspace GC does not remove the build log',
    !/build-log/.test(workspaceSrc.slice(workspaceSrc.indexOf('collectWorkspaceGarbage'))));

  const runtimeSrc = await readFile(path.resolve('src/agents/claudeCodeRuntime.ts'), 'utf8');
  check('the runtime traces the SDK stream when a log path is given',
    /summarizeSdkMessage\(m, trace\.agent\)/.test(runtimeSrc));
  check('the builder passes its log path to the agent',
    /buildLogPath: logPath/.test(await readFile(path.resolve('src/workers/builder.ts'), 'utf8')));
  check('the API exposes the log read-only',
    /app\.get\('\/internal\/build-log\/:businessId', internalAuth/.test(
      await readFile(path.resolve('src/api/server.ts'), 'utf8')));
}

await rm(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
