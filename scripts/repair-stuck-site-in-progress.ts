/**
 * Repair for businesses left in `site_in_progress` by a content-and-design job
 * that could never succeed.
 *
 * Why this exists (2026-08-16, found during final integration): the factory
 * image ran as root, and the agent layer drives Claude Code with
 * `permissionMode: 'bypassPermissions'` — which the CLI implements as
 * `--dangerously-skip-permissions` and REFUSES to run as root. Every
 * `content-and-design` job therefore failed after moving the business to
 * `site_in_progress`, stranding it there. The image now runs as `node`
 * (see Dockerfile), and this script puts the stranded rows back.
 *
 * It only touches a business when ALL of these hold, so it can never undo real
 * progress:
 *   - status is exactly `site_in_progress`
 *   - the business has NO site_projects row (no build ever started)
 *
 * Every change is written to `status_history` with actor `integration-repair`.
 *
 *   pnpm tsx scripts/repair-stuck-site-in-progress.ts            # dry run
 *   pnpm tsx scripts/repair-stuck-site-in-progress.ts --apply
 */
import 'dotenv/config';
import { pool } from '../src/db/client.js';
import { businessTransitions } from '../src/orchestrator/statuses.js';

const APPLY = process.argv.includes('--apply');

const SELECT = `
  select b.id, b.campaign_id
    from businesses b
   where b.status = 'site_in_progress'
     and not exists (select 1 from site_projects sp where sp.business_id = b.id)
   order by b.id`;

const { rows } = await pool.query<{ id: string; campaign_id: string }>(SELECT);

if (!rows.length) {
  console.log('nothing to repair: no site_in_progress business lacks a site_project');
} else {
  console.log(`${rows.length} business(es) stranded in site_in_progress with no site_project:`);
  rows.forEach((r) => console.log(`  · ${r.id}  (${r.campaign_id})`));

  if (!APPLY) {
    console.log('\ndry run — pass --apply to move them back to production_ready');
  } else {
    let restored = 0;
    for (const row of rows) {
      const result = await businessTransitions.recover({
        businessId: row.id,
        expectedStatus: 'site_in_progress',
        to: 'production_ready',
        actor: 'integration-repair',
        reason: 'content-and-design could not run (container was root; Claude Code refuses --dangerously-skip-permissions). No site_project was created.',
      });
      if (result.kind === 'moved') restored++;
    }
    console.log(`\n✅ restored ${restored} business(es) to production_ready`);
  }
}

const summary = await pool.query<{ campaign_id: string; status: string; n: string }>(
  `select campaign_id, status, count(*)::text as n from businesses
    group by 1, 2 order by 1, 3 desc`,
);
console.log('\nfunnel now:');
summary.rows.forEach((r) => console.log(`  ${r.campaign_id.padEnd(24)} ${r.status.padEnd(18)} ${r.n}`));

await pool.end();
