/**
 * Stage 10 — site build (SPEC §4, §2.3).
 *
 * A real Claude Code agent (subscription runtime) gets an isolated workspace with
 * the Next.js template, the frozen snapshot, the content brief, the chosen art
 * direction and the local assets. The pipeline installs workspace dependencies;
 * the agent writes the site, runs `pnpm build`, and fixes its own build errors.
 *
 * Then CODE verifies, because the agent's self-report is not evidence:
 *   1. `out/index.html` exists;
 *   2. `pnpm build` is re-run independently and must be green;
 *   3. the exported HTML is grepped for contact details, external links and image
 *      sources, and every one must trace to the snapshot (src/build/provenance.ts).
 *
 * A provenance failure is not a crash — it becomes a QA issue and goes back to the
 * SAME workspace, exactly like a visual issue would.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getObject } from '../lib/storage.js';
import { runCodeAgent } from '../agents/codeAgent.js';
import {
  artifactProducedDuringInvocation,
  invocationFromError,
} from '../agents/result.js';
import { config } from '../config.js';
import { commitWorkflow, type JobPayload } from '../orchestrator/queue.js';
import { JobSkippedError } from '../orchestrator/jobSkipped.js';
import { buildSnapshot } from '../build/snapshot.js';
import { BuildResultSchema, DESIGN_CONTRACT_VERSION, type ArtDirection, type BuildResult, type ContentBrief } from '../build/schemas.js';
import type { RubricVerdict } from '../build/rubric.js';
import { checkProvenance, type ProvenanceReport } from '../build/provenance.js';
import { generateDecorativeBackground, planHeroMedia } from '../build/media.js';
import { outputDir, prepareWorkspace, workspaceDir, SITES_ROOT } from '../build/workspace.js';
import { buildLogPath, logStage } from '../build/buildLog.js';
import {
  ensureWorkspaceDependencies, workspaceDependenciesReady,
} from '../build/dependencies.js';
import { log } from '../lib/logger.js';
import { resolveProject } from '../build/projectRef.js';

export { SITES_ROOT };

/** Kept for callers outside phase C (deploy, QA) that only know a directory. */
export function siteOutputDir(projectDir: string): string {
  return outputDir(projectDir);
}

/** Run a command in the workspace and capture output; used to verify the build. */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      // The agent's own env is irrelevant here: this is a plain build.
      env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (b: Buffer) => { output += b.toString(); if (output.length > 200_000) output = output.slice(-100_000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { child.kill('SIGKILL'); output += '\n[timeout]'; }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: `${output}\n${String(err)}` }); });
  });
}

/** Turn provenance findings into the same issue strings the QA loop feeds back. */
function provenanceIssues(report: ProvenanceReport): string[] {
  return report.findings
    .filter((f) => f.severity === 'high')
    .map((f) => `provenance [${f.kind}] in ${f.file}: ${f.detail}`);
}

export async function buildSiteHandler(payload: JobPayload): Promise<void> {
  const startedAt = Date.now();
  const businessId = payload.businessId!;
  const project = await resolveProject('builder', payload);
  const projectId = project.id;
  const iteration = (payload.iteration as number | undefined) ?? 0;
  const issues = (payload.issues as string[] | undefined) ?? [];



  const dir = workspaceDir(businessId, projectId);
  const isFix = iteration > 0 && existsSync(path.join(dir, 'package.json'));

  // The live trace Roman watches while this runs. Written into the workspace
  // itself, so `factory` (which serves the API) reads it off the shared
  // `sitesdata` volume without this process having to publish anything.
  const logPath = buildLogPath(businessId);
  await logStage(
    logPath,
    isFix
      ? `Ітерація ${iteration}: агент виправляє зауваження QA`
      : 'Збірка почалась: готую воркспейс',
    'site-builder',
  );

  const [claimed] = await db.update(schema.siteProjects)
    .set({ state: 'building', dir })
    .where(and(
      eq(schema.siteProjects.id, projectId),
      inArray(schema.siteProjects.state, ['brief', 'building', 'qa']),
    ))
    .returning({ id: schema.siteProjects.id });
  if (!claimed) {
    log.info('stale builder delivery ignored: project is no longer buildable', {
      businessId,
      projectId,
    });
    throw new JobSkippedError(
      `Проєкт ${projectId} уже не в збірці (скасований, впав або перейшов далі) — цю доставку пропущено. Нова збірка починається кнопкою «Побудувати заново».`,
    );
  }

  let prompt: string;
  let snapshot = await buildSnapshot(businessId);

  if (isFix) {
    // Fix iteration: the workspace already holds the agent's own code. Only the
    // issue list is new — re-preparing inputs would throw away its work.
    const qaIssuesPath = path.join(dir, 'QA-ISSUES.md');
    const qaText = existsSync(qaIssuesPath) ? await readFile(qaIssuesPath, 'utf8') : issues.map((i) => `- ${i}`).join('\n');
    prompt = `You built this demo site. Automated QA found concrete issues. Read \`QA-ISSUES.md\`,
fix EXACTLY those issues, and change nothing else — the rest of the page passed review.

${qaText}

SOURCE PRIORITY, read this before anything else: \`QA-ISSUES.md\` — and above all the owner's
note at its top, when there is one — OVERRIDE \`BUILD-TASK.md\` and \`DESIGN.md\` wherever the
two disagree. "Change nothing else" protects the rest of the page from regressions; it does
NOT protect the listed issues from being fixed. If the contract told you to build the thing
QA now flags, the contract loses for this iteration — implement what the issue's \`fix:\` line
says instead, and verify the new rendering in _shots.

Other constraints are unchanged and still binding: re-read \`BUILD-TASK.md\` before you start.
In particular: facts only from \`input/snapshot.json\`, only snapshot contacts, images only from
\`public/assets/\` and \`public/generated/\`, copy in ${snapshot.languageName}, noindex stays,
reduced motion must render a complete page.

When done run \`pnpm build\` until it is green and \`out/index.html\` exists.

Then LOOK at what you changed: run \`pnpm shot\` and Read \`_shots/desktop.png\` and
\`_shots/mobile.png\` — verify each fixed issue is actually fixed ON SCREEN, not just in code.
If any issue you fixed is about MOTION, also run \`pnpm shot --motion\` and Read the
\`_shots/motion-load-t*.png\` / \`_shots/motion-scroll-*pct.png\` frames — a motion fix you
cannot SEE in the frames is not fixed.
What you saw goes into \`selfReview\` in result.json. For \`referenceNotes\` in a fix iteration,
list what you re-checked visually (your own _shots, any \`references/\` images still present —
the folder may have been garbage-collected; if so, say that).

FINAL STEP, do not skip it: write \`result.json\` in the workspace root. Write it as the very
last action, even if you think you are finished — the pipeline reads it as your report.`;
  } else {
    // Fresh build: rebuild the workspace from the frozen documents.
    const brief = JSON.parse((await getObject('raw', project.contentBriefKey!)).toString()) as ContentBrief;
    const designDoc = JSON.parse((await getObject('raw', project.designContractKey!)).toString()) as {
      schemaVersion?: number;
      chosen: ArtDirection;
      rubric: {
        ranking: RubricVerdict['ranking']; rationale: string;
        chosenWow?: RubricVerdict['chosenWow'];
      };
    };

    // Compatibility policy (Roman, 2026-08-22): no field-level fallbacks for
    // old frozen contracts — a contract of an older schema regenerates the
    // design from scratch under the current one. The stale project is closed
    // honestly and a fresh content-and-design run creates its successor.
    if ((designDoc.schemaVersion ?? 1) !== DESIGN_CONTRACT_VERSION) {
      log.warn('design contract is an older schema; regenerating the design instead of building', {
        businessId, projectId, contractVersion: designDoc.schemaVersion ?? 1, current: DESIGN_CONTRACT_VERSION,
      });
      await logStage(
        buildLogPath(businessId),
        'Дизайн-контракт застарілого формату — фабрика генерує дизайн заново (нова схема)',
        'site-builder',
      );
      let regenerationQueued = false;
      await commitWorkflow(async (tx) => {
        const [closed] = await tx.update(schema.siteProjects)
          .set({ state: 'failed' })
          .where(and(
            eq(schema.siteProjects.id, projectId),
            eq(schema.siteProjects.state, 'building'),
          ))
          .returning({ id: schema.siteProjects.id });
        if (!closed) return [];
        regenerationQueued = true;
        return [{
          name: 'content-and-design',
          payload: {
            businessId,
            campaignId: payload.campaignId,
            idempotencyKey: `content-and-design:${businessId}:regen-v${DESIGN_CONTRACT_VERSION}:${projectId}`,
          },
        }];
      });
      if (!regenerationQueued) {
        throw new JobSkippedError(
          `Проєкт ${projectId} змінив стан, поки закривався застарілий дизайн-контракт — регенерацію не поставлено.`,
        );
      }
      return;
    }
    if (project.snapshotKey) {
      // Use the FROZEN snapshot, not a fresh read: the design was chosen against it.
      snapshot = JSON.parse((await getObject('raw', project.snapshotKey)).toString());
    }

    const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, biz!.campaignId));

    // Optional media. Both degrade silently; neither can fail the build.
    const heroMedia = await planHeroMedia(snapshot, projectId, { category: biz?.category });
    await generateDecorativeBackground(snapshot, projectId, designDoc.chosen);

    const verdict: RubricVerdict = {
      chosen: designDoc.chosen,
      chosenScore: project.designScore ?? 0,
      ranking: designDoc.rubric?.ranking ?? [],
      rationale: designDoc.rubric?.rationale ?? '',
      // Contracts frozen before the motion pack landed carry no wow estimate. An
      // absent score is recorded as "not measured" (empty axes, no reasons), not
      // as a zero — the build task only ever reads the axes it is given.
      chosenWow: designDoc.rubric?.chosenWow
        ?? { total: 0, ambition: 0, passed: false, reasons: ['no wow estimate in this design contract'], axes: {} as never },
    };

    await prepareWorkspace({
      snapshot, brief, design: designDoc.chosen, verdict, heroMedia,
      projectId, niche: campaign?.niche ?? 'beauty', fresh: true,
    });
    await logStage(
      logPath,
      `Воркспейс готовий · напрямок «${designDoc.chosen.name}» · фото: ${snapshot.assets.length}`,
      'site-builder',
    );

    prompt = `Build the demo website described in \`BUILD-TASK.md\` in this workspace.

Read \`BUILD-TASK.md\` first — it is the contract, written by the pipeline, not by a model.
Then \`DESIGN.md\`, \`components/README.md\` and the ONE reference named in \`input/design.json\`.

Replace \`app/page.tsx\`, the layout metadata and fonts, and \`app/globals.css\` with the real
site. Add components under \`components/\` as needed; the pool in \`components/ui/\` is
copy-paste code you may edit freely.

Dependencies are already installed by the pipeline. Run \`pnpm build\`, fix any errors
yourself, and confirm
\`out/index.html\` exists. The pipeline re-runs \`pnpm build\` independently afterwards and
greps the exported HTML against the snapshot, so a self-report of success that does not hold
up will simply come back to you as issues.

FINAL STEP, do not skip it: write \`result.json\` in the workspace root as your very last
action. Everything else can be perfect and the run still reports badly without it.`;
  }

  // Fresh workspaces never copy node_modules, and terminal-state GC removes it
  // before a human can request another QA iteration. Installing dependencies is
  // deterministic pipeline setup, not a prompt instruction the agent may skip.
  if (!workspaceDependenciesReady(dir)) {
    await logStage(logPath, 'Відновлюю залежності воркспейсу', 'site-builder');
  }
  const dependencies = await ensureWorkspaceDependencies(
    dir,
    (command, args, cwd) => run(command, args, cwd, config.build.verifyTimeoutMs),
  );
  if (dependencies.installed) {
    await logStage(logPath, 'Залежності готові — передаю воркспейс агенту', 'site-builder');
  }

  // ── The agent works ───────────────────────────────────────────────────────
  const agentStarted = Date.now();

  /**
   * `result.json` is the agent's SELF-REPORT, not the deliverable. The deliverable
   * is a green `pnpm build` and an `out/` this code verifies itself a few lines
   * below. Observed for real: a builder agent finished successfully in 36 turns,
   * wrote a correct site, and simply never wrote result.json — throwing away a
   * verified-good build over a missing status file is the wrong trade.
   *
   * So a missing/invalid result.json degrades to a synthesised one only when this
   * invocation produced `out/index.html`, and is recorded as an unresolved note.
   * An old output in a reused QA workspace is never recovery evidence. A build
   * that is genuinely broken still fails, because the independent build and
   * provenance checks below are what actually gate.
   */
  await logStage(
    logPath,
    `Агент почав працювати (ліміт ${isFix ? config.build.fixMaxTurns : config.build.maxTurns} кроків, `
    + `${Math.round(config.build.timeoutMs / 60_000)} хв)`,
    'site-builder',
  );

  let result: BuildResult;
  try {
    result = await runCodeAgent(
      {
        name: `site-builder:${businessId}:${iteration}`,
        cwd: dir,
        prompt,
        // Fresh builds always run the heavy model; fix iterations may drop to
        // the light one (AGENT_FIX_LIGHT) — the edits are small and named.
        heavy: !isFix || !config.agents.fixIterationsLight,
        kind: 'builder',
        maxTurns: isFix ? config.build.fixMaxTurns : config.build.maxTurns,
        timeoutMs: config.build.timeoutMs,
        buildLogPath: logPath,
        // The GSAP skills copied into <workspace>/.claude/skills/ are only offered
        // to the model when skills are explicitly enabled.
        skills: 'all',
        // Spec §9 metrics: turns and estimated subscription cost per build iteration.
        onUsage: (u) => log.info('agent usage', { businessId, projectId, iteration, call: 'site-builder', ...u }),
      },
      BuildResultSchema,
    );
  } catch (err) {
    const invocation = invocationFromError(err);
    const builtAnyway = invocation
      ? await artifactProducedDuringInvocation(path.join(dir, 'out', 'index.html'), invocation)
      : false;
    await logStage(
      logPath,
      builtAnyway
        ? 'Агент завершився без звіту, але зібрана сторінка є — перевіряю її'
        : `Агент впав: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      'site-builder',
    );
    if (!builtAnyway) throw err; // nothing to salvage
    log.warn('builder agent produced no valid result.json but did produce a build; continuing to verification', {
      businessId, projectId, iteration, err: String((err as Error)?.message ?? err).slice(0, 300),
    });
    result = {
      ok: true,
      pages: ['/'],
      notes: 'result.json missing or invalid; reconstructed by the pipeline after finding a built out/.',
      usedAssets: [],
      unresolved: ['builder agent did not write a valid result.json'],
      referenceNotes: '(звіту немає — невідомо, чи агент дивився референси)',
      selfReview: '(звіту немає — самоперевірка не підтверджена)',
    };
  }
  const agentSeconds = Math.round((Date.now() - agentStarted) / 1000);

  log.info('builder agent finished', {
    businessId, projectId, iteration, ok: result.ok, agentSeconds,
    pages: result.pages, unresolved: result.unresolved.length,
    notes: result.notes.slice(0, 200),
  });

  await logStage(
    logPath,
    `Агент закінчив за ${Math.round(agentSeconds / 60)} хв`
    + (result.unresolved.length ? ` · невирішених питань: ${result.unresolved.length}` : ''),
    'site-builder',
  );

  if (!result.ok) {
    throw new Error(
      `builder agent reported failure: ${result.notes.slice(0, 400)}` +
      (result.unresolved.length ? ` | unresolved: ${result.unresolved.join('; ').slice(0, 300)}` : ''),
    );
  }

  // ── CODE verifies (the agent is not trusted) ──────────────────────────────
  // Re-check after the agent as well. It normally becomes a no-op, but keeps
  // verification deterministic if an agent cleaned node_modules while editing.
  await ensureWorkspaceDependencies(
    dir,
    (command, args, cwd) => run(command, args, cwd, config.build.verifyTimeoutMs),
  );
  await logStage(logPath, 'Перевіряю збірку незалежно: pnpm build', 'site-builder');
  const verify = await run('pnpm', ['build'], dir, config.build.verifyTimeoutMs);
  if (verify.code !== 0) {
    await logStage(logPath, `pnpm build впав (код ${verify.code})`, 'site-builder');
    throw new Error(
      `independent \`pnpm build\` failed after the agent reported success (exit ${verify.code}): ` +
      verify.output.slice(-1500),
    );
  }
  const out = path.join(dir, 'out');
  if (!existsSync(path.join(out, 'index.html'))) {
    throw new Error('independent build succeeded but out/index.html is missing');
  }

  const provenance = await checkProvenance(out, snapshot);
  const provIssues = provenanceIssues(provenance);
  log.info('provenance checked', {
    businessId, projectId, ok: provenance.ok,
    findings: provenance.findings.length, high: provIssues.length,
    contactsPresent: provenance.contactsPresent,
  });

  let handedOff = false;
  await commitWorkflow(async (tx) => {
    const [updated] = await tx.update(schema.siteProjects)
      .set({ state: 'qa', dir, buildOk: true, buildSeconds: agentSeconds })
      .where(and(
        eq(schema.siteProjects.id, projectId),
        eq(schema.siteProjects.state, 'building'),
      ))
      .returning({ id: schema.siteProjects.id });
    if (!updated) return [];
    handedOff = true;
    return [{
      name: 'visual-qa',
      payload: {
        businessId,
        projectId,
        campaignId: payload.campaignId,
        iteration,
        provenanceIssues: provIssues,
        provenanceFindings: provenance.findings,
        buildNotes: result.notes,
        unresolved: result.unresolved,
        idempotencyKey: `visual-qa:${businessId}:${projectId}:${iteration}`,
      },
    }];
  });
  if (!handedOff) {
    log.info('builder result discarded: project was stopped while the agent ran', {
      businessId,
      projectId,
    });
    throw new JobSkippedError(
      `Збірку зупинили, поки агент працював — результат проєкту ${projectId} не переданий на перевірку.`,
    );
  }

  log.info('stage 10 complete', {
    businessId, projectId, iteration, totalSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
  await logStage(
    logPath,
    `Збірка зелена${provIssues.length ? `, але провенанс дав ${provIssues.length} зауваж.` : ''}`
    + ' — передаю на візуальну перевірку',
    'site-builder',
  ).catch((error) => log.warn('build log write failed after QA handoff commit', {
    businessId,
    projectId,
    error: String(error),
  }));

}
