/**
 * Stage 12 — private demo deploy (SPEC §4, §8).
 *
 * The exported `out/` is copied to `deploys/<token>/` under an unguessable
 * 24-character token and served by the demo static server (`src/lib/serveDir.ts`
 * → `startDemoServer`) with `X-Robots-Tag: noindex, nofollow` and no directory
 * listing. A public/customer domain is NEVER created here: the demo is private
 * until Roman approves outreach, and even then it stays on this host.
 *
 * The health check is a real GET: 200, noindex header, and the business name in
 * the returned HTML. A deploy that cannot be opened is a failure, not a URL.
 */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import {
  businessTransitions,
  requireBusinessStatus,
} from '../orchestrator/statuses.js';
import { commitWorkflow, type JobPayload } from '../orchestrator/queue.js';
import { JobSkippedError } from '../orchestrator/jobSkipped.js';
import { collectWorkspaceGarbage, outputDir } from '../build/workspace.js';
import { buildLogPath, logStage } from '../build/buildLog.js';
import { ensureDemoServer } from '../lib/serveDir.js';
import { log } from '../lib/logger.js';
import { resolveProject } from '../build/projectRef.js';

/**
 * 24 chars from a 36-symbol alphabet ≈ 124 bits. Well past the "unguessable URL"
 * requirement, and short enough to paste into a Telegram message.
 */
const token = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

export const DEPLOYS_ROOT = path.resolve(process.env.DEPLOYS_DIR ?? 'deploys');

/**
 * Rewrite root-absolute asset paths to be relative to the demo's own directory.
 *
 * A Next.js static export emits `/_next/static/...`, `/assets/...` and
 * `/generated/...` with a LEADING SLASH — absolute from the server root. Each
 * demo is served from `/<token>/`, so a browser on that page requests
 * `/_next/...`, which does not exist: the page loads completely unstyled with
 * every font 404ing. This was caught only by looking at the deployed page — the
 * export itself is fine when served from its own root, so QA on `out/` passes.
 *
 * Rewriting to `./_next/...` at deploy time keeps the export portable (no
 * basePath baked in, so a redeploy under a new token still works) and needs no
 * rebuild. `trailingSlash: true` guarantees the page URL ends in `/`, so a
 * relative path resolves inside the demo directory.
 */
async function relativizeAssetPaths(dir: string): Promise<number> {
  let rewritten = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(html|css|js|txt)$/i.test(entry.name)) continue;
      const original = await readFile(full, 'utf8');
      // Depth of this file below the demo root decides how far back "./" must go.
      const depth = path.relative(dir, path.dirname(full)).split(path.sep).filter(Boolean).length;
      const prefix = depth === 0 ? './' : '../'.repeat(depth);
      const updated = original
        .replace(/(["'(])\/(_next|assets|generated)\//g, `$1${prefix}$2/`)
        .replace(/(["'(])\\\/(_next|assets|generated)\\\//g, `$1${prefix}$2/`);
      if (updated !== original) { await writeFile(full, updated); rewritten++; }
    }
  };
  await walk(dir);
  return rewritten;
}

/** Health-check the deployed URL: reachable, private, and actually this business. */
async function healthCheck(url: string, businessName: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const robots = res.headers.get('x-robots-tag') ?? '';
    if (!/noindex/i.test(robots)) return { ok: false, detail: `missing X-Robots-Tag noindex (got "${robots}")` };
    const html = await res.text();
    if (!/name=["']robots["'][^>]*noindex/i.test(html)) {
      return { ok: false, detail: 'served HTML has no robots noindex meta tag' };
    }
    // First word of the name: enough to prove we served the right site, tolerant
    // of the business styling the rest of its name differently.
    const firstWord = businessName.trim().split(/\s+/)[0] ?? '';
    if (firstWord.length >= 3 && !html.toLowerCase().includes(firstWord.toLowerCase())) {
      return { ok: false, detail: `served page does not mention "${firstWord}"` };
    }
    // The stylesheet must actually be reachable FROM THIS URL. A Next export
    // whose asset paths are absolute serves a 200 page with a 404 stylesheet —
    // completely unstyled, and invisible to a status-code-only check.
    const cssHref = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1]
      ?? /<link[^>]+href=["']([^"']+\.css)["']/i.exec(html)?.[1];
    if (cssHref) {
      const cssUrl = new URL(cssHref, url).toString();
      const cssRes = await fetch(cssUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!cssRes?.ok) {
        return { ok: false, detail: `stylesheet ${cssHref} is not reachable from ${url} (${cssRes?.status ?? 'network error'}) — the demo would render unstyled` };
      }
      const cssBody = await cssRes.text();
      if (cssBody.trim().length < 500) {
        return { ok: false, detail: `stylesheet ${cssHref} served only ${cssBody.length} bytes — the demo would render unstyled` };
      }
    }
    return { ok: true, detail: `HTTP 200, noindex, ${html.length} bytes, stylesheet ok` };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  }
}

/** Reserve the public path before copying files so retries reuse one target. */
async function reserveDeployToken(projectId: number): Promise<string> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ deployToken: schema.siteProjects.deployToken })
      .from(schema.siteProjects)
      .where(eq(schema.siteProjects.id, projectId))
      .limit(1)
      .for('update');
    if (!project) throw new Error(`site project not found: ${projectId}`);
    if (project.deployToken) return project.deployToken;
    const reserved = token();
    await tx.update(schema.siteProjects)
      .set({ deployToken: reserved })
      .where(eq(schema.siteProjects.id, projectId));
    return reserved;
  });
}

export async function deployHandler(payload: JobPayload): Promise<void> {
  const businessId = payload.businessId!;
  const project = await resolveProject('deploy', payload);
  const projectId = project.id;

  if (project.state !== 'ready' && project.state !== 'deployed') {
    throw new Error(`project not ready for deploy: state=${project.state}`);
  }
  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (!biz) throw new Error(`business not found: ${businessId}`);
  const expectedStatus = requireBusinessStatus(biz.status, `business ${businessId}`);
  if (!['site_in_progress', 'site_ready'].includes(expectedStatus)) {
    log.info('deploy skipped: business no longer belongs to the build flow', {
      businessId,
      status: expectedStatus,
    });
    throw new JobSkippedError(`Бізнес у стані «${expectedStatus}», не в збірці — публікацію демо пропущено.`);
  }

  const source = outputDir(project.dir);
  if (!existsSync(path.join(source, 'index.html'))) {
    throw new Error(`no exported site to deploy at ${source}`);
  }

  // The token is durably reserved before the external filesystem effect. A
  // crash after copying cannot make the retry publish a second orphan URL.
  const slug = await reserveDeployToken(projectId);
  const target = path.join(DEPLOYS_ROOT, slug);
  await mkdir(DEPLOYS_ROOT, { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== '.next' && base !== 'input' && base !== 'result.json';
    },
  });

  // Absolute asset paths must become relative BEFORE the health check, or the
  // demo serves unstyled with every asset 404ing.
  const rewritten = await relativizeAssetPaths(target);

  // The demo server must be up for the health check to mean anything.
  await ensureDemoServer();

  const deployUrl = `${config.deploy.demoBaseUrl.replace(/\/+$/, '')}/${slug}/`;
  const health = await healthCheck(deployUrl, biz.name);
  if (!health.ok) {
    throw new Error(`deploy health check failed for ${deployUrl}: ${health.detail}`);
  }

  let completed = false;
  await commitWorkflow(async (tx) => {
    const [lockedProject] = await tx.select({ state: schema.siteProjects.state })
      .from(schema.siteProjects)
      .where(eq(schema.siteProjects.id, projectId))
      .limit(1)
      .for('update');
    if (!lockedProject || !['ready', 'deployed'].includes(lockedProject.state)) return [];

    const [lockedBusiness] = await tx.select({
      status: schema.businesses.status,
      campaignId: schema.businesses.campaignId,
    }).from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1)
      .for('update');
    if (!lockedBusiness) throw new Error(`business not found: ${businessId}`);
    const currentStatus = requireBusinessStatus(lockedBusiness.status, `business ${businessId}`);
    if (!['site_in_progress', 'site_ready'].includes(currentStatus)) return [];

    const transitioned = await businessTransitions.normalInTransaction(tx, {
      businessId,
      expectedStatus: currentStatus,
      to: 'site_ready',
      actor: 'deploy-worker',
      reason: deployUrl,
    });
    if (transitioned.kind === 'conflict') {
      throw new Error(`deploy lost its locked transition for ${businessId}`);
    }
    const [updated] = await tx.update(schema.siteProjects).set({
      deployUrl,
      deployToken: slug,
      deployedAt: new Date(),
      state: 'deployed',
    }).where(and(
      eq(schema.siteProjects.id, projectId),
      inArray(schema.siteProjects.state, ['ready', 'deployed']),
    )).returning({ id: schema.siteProjects.id });
    if (!updated) throw new Error(`deploy lost its locked project ${projectId}`);
    completed = true;
    return [{
      name: 'request-approval',
      payload: {
        businessId,
        campaignId: lockedBusiness.campaignId,
        idempotencyKey: `request-approval:${businessId}`,
      },
    }];
  });
  if (!completed) {
    log.info('deploy result discarded: project or business already advanced', { businessId, projectId });
    throw new JobSkippedError(`Проєкт ${projectId} або бізнес уже перейшли далі — опубліковане демо не зафіксовано.`);
  }

  log.info('demo deployed', { businessId, projectId, deployUrl, health: health.detail, filesRewritten: rewritten });
  await logStage(buildLogPath(businessId), `Демо опубліковано: ${deployUrl}`, 'deploy')
    .catch((error) => log.warn('build log write failed after deploy commit', {
      businessId,
      projectId,
      error: String(error),
    }));
  // Only reclaim source artifacts after the durable project/status/approval
  // handoff commits. A queue failure must leave a retryable workspace behind.
  await collectWorkspaceGarbage(project.dir, 'deployed').catch(() => {});
}
