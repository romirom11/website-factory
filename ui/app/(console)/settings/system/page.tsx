import Link from 'next/link';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { SystemStatusPanel } from '@/components/SystemStatusPanel';
import { EffectiveConfigPanel } from '@/components/EffectiveConfigPanel';
import { loadSystemStatus } from '@/lib/systemStatus';
import { JobRunList, type JobRunView } from '@/components/JobRunList';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { key: '', label: 'Усі' },
  { key: 'failed', label: 'Помилки' },
  { key: 'needs_human', label: 'Чекають рішення' },
  { key: 'retry_wait', label: 'На паузі' },
  { key: 'running', label: 'Виконуються' },
  { key: 'queued', label: 'У черзі' },
  { key: 'succeeded', label: 'Готові' },
  // 88 rows carry this — the second-largest bucket. Without a chip the only
  // way to see what the reconciler closed was to read the whole list.
  { key: 'stale', label: 'Втрачені' },
  // A stopped build and a skipped delivery used to vanish from every filter:
  // the only proof they existed was a gap in the attempt numbers.
  { key: 'cancelled', label: 'Скасовані' },
  { key: 'skipped', label: 'Пропущені' },
];

/**
 * "Система": is anything broken, and what has the queue been doing.
 *
 * KNOWN, non-blocking: this page occasionally (~1 load in 25) logs a React
 * hydration warning (#418) and re-renders the subtree client-side. Two
 * consecutive server renders are byte-identical and the streamed HTML matches
 * its own RSC payload, so it is not a data mismatch; measured after it fires,
 * the page is complete and fully interactive (all job rows, working filters and
 * Retry buttons). The `now`-derived values that DID cause a frequent version of
 * it — a per-second heartbeat age rendered in `SystemStatusPanel` — are fixed:
 * `loadHeartbeats` now emits a fixed clock time and a pre-decided `stale` flag,
 * which took it from ~1-in-3 to ~1-in-25. Left as is rather than papering over
 * it with `suppressHydrationWarning`, which would hide a real one later.
 *
 * This is the page that stayed technical on purpose. Everywhere else the
 * console speaks about businesses; here Roman is looking under the hood, and a
 * job type, an attempt count and a raw error are the useful facts. What did
 * change is the vocabulary of the STATUS column — "пауза: ліміт підписки"
 * instead of `retry_wait`, because misreading that one as a failure sends him
 * debugging something that is working as designed.
 */
export default async function SystemPage({
  searchParams,
}: { searchParams: Promise<{ status?: string; type?: string }> }) {
  const { status, type } = await searchParams;

  const runWhere: SQL[] = [];
  const legacyWhere: SQL[] = [isNull(schema.workflowJobs.runId)];
  if (status) {
    runWhere.push(eq(schema.workflowJobRuns.status, status));
    legacyWhere.push(eq(schema.workflowJobs.status, status));
  }
  if (type) {
    runWhere.push(eq(schema.workflowJobRuns.jobType, type));
    legacyWhere.push(eq(schema.workflowJobs.jobType, type));
  }

  // Read a little more from both ledgers, merge by time, then enforce one page
  // cap. During the additive rollout old terminal rows have no run_id and stay
  // visible beside native logical runs until retention removes them.
  const PAGE = 40;
  const [status_, counts, runRows, legacyRows] = await Promise.all([
    loadSystemStatus(),
    db.execute(sql`
      select coalesce(r.status, w.status) as status, count(*)::int as n
      from workflow_jobs w
      left join workflow_job_runs r on r.id = w.run_id
      where w.run_id is null or w.attempt_sequence = r.current_attempt_sequence
      group by coalesce(r.status, w.status)
    `),
    db.select().from(schema.workflowJobRuns)
      .where(runWhere.length ? and(...runWhere) : undefined)
      .orderBy(desc(schema.workflowJobRuns.createdAt))
      .limit(PAGE),
    db.select().from(schema.workflowJobs)
      .where(and(...legacyWhere))
      .orderBy(desc(schema.workflowJobs.createdAt))
      .limit(PAGE),
  ]);
  const byStatus = new Map(
    (counts.rows as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
  );

  const runIds = runRows.map((run) => run.id);
  const attempts = runIds.length
    ? await db.select().from(schema.workflowJobs)
      .where(inArray(schema.workflowJobs.runId, runIds))
      .orderBy(asc(schema.workflowJobs.attemptSequence))
    : [];
  const attemptsByRun = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    if (!attempt.runId) continue;
    const rows = attemptsByRun.get(attempt.runId) ?? [];
    rows.push(attempt);
    attemptsByRun.set(attempt.runId, rows);
  }

  const selected = [
    ...runRows.map((run) => ({ kind: 'run' as const, createdAt: run.createdAt, run })),
    ...legacyRows.map((attempt) => ({ kind: 'legacy' as const, createdAt: attempt.createdAt, attempt })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, PAGE);

  // The job list identified businesses by raw id (`gr-patras-abige-hair-nail`),
  // which is the one page-level place the console still asked Roman to read a
  // slug instead of a name (sweep P2-3). One lookup over the ids actually on
  // this page — not a join, because the page is capped at 40 rows anyway.
  const jobBusinessIds = [...new Set(selected
    .map((item) => item.kind === 'run' ? item.run.businessId : item.attempt.businessId)
    .filter((id): id is string => Boolean(id)))];
  const jobBusinessNames = new Map<string, string>(
    jobBusinessIds.length
      ? (await db.select({ id: schema.businesses.id, name: schema.businesses.name })
        .from(schema.businesses)
        .where(inArray(schema.businesses.id, jobBusinessIds)))
        .map((b) => [b.id, b.name])
      : [],
  );

  const jobs: JobRunView[] = selected.map((item) => {
    if (item.kind === 'legacy') {
      const attempt = item.attempt;
      return {
        key: `legacy-${attempt.id}`,
        runId: null,
        jobType: attempt.jobType,
        businessId: attempt.businessId,
        businessName: attempt.businessId ? jobBusinessNames.get(attempt.businessId) ?? null : null,
        campaignId: attempt.campaignId,
        status: attempt.status,
        currentAttemptSequence: null,
        duplicateSuppressions: 0,
        lastDuplicateAt: null,
        createdAt: attempt.createdAt,
        attempts: [{
          id: attempt.id,
          sequence: null,
          status: attempt.status,
          attempts: attempt.attempts,
          nextAttemptAt: attempt.nextAttemptAt,
          errorCode: attempt.errorCode,
          errorDetail: attempt.errorDetail,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          createdAt: attempt.createdAt,
        }],
      };
    }

    const run = item.run;
    return {
      key: run.id,
      runId: run.id,
      jobType: run.jobType,
      businessId: run.businessId,
      businessName: run.businessId ? jobBusinessNames.get(run.businessId) ?? null : null,
      campaignId: run.campaignId,
      status: run.status,
      currentAttemptSequence: run.currentAttemptSequence,
      duplicateSuppressions: run.duplicateSuppressions,
      lastDuplicateAt: run.lastDuplicateAt,
      createdAt: run.createdAt,
      attempts: (attemptsByRun.get(run.id) ?? []).map((attempt) => ({
        id: attempt.id,
        sequence: attempt.attemptSequence,
        status: attempt.status,
        attempts: attempt.attempts,
        nextAttemptAt: attempt.nextAttemptAt,
        errorCode: attempt.errorCode,
        errorDetail: attempt.errorDetail,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        createdAt: attempt.createdAt,
      })),
    };
  });

  return (
    <div>
      <div className="space-y-6">
        <SystemStatusPanel status={status_} />

        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-line">
            <h2 className="h-section">Кроки фабрики</h2>
            <p className="text-sm text-ink-mute mt-1 max-w-[62ch]">
              «На паузі» — це не помилка: вичерпався ліміт підписки, черга продовжить сама.
            </p>
          </div>

          <div className="flex gap-1.5 flex-wrap px-5 py-3 border-b border-line">
            {FILTERS.map((f) => {
              const active = (status ?? '') === f.key;
              const n = f.key
                ? byStatus.get(f.key) ?? 0
                : [...byStatus.values()].reduce((a, b) => a + b, 0);
              return (
                <Link
                  key={f.key || 'all'}
                  href={f.key ? `/settings/system?status=${f.key}` : '/settings/system'}
                  className={`rounded-full border px-3 py-1.5 text-sm no-underline transition-colors ${
                    active
                      ? 'bg-accent text-white border-accent'
                      : 'bg-paper-card text-ink-soft border-line hover:border-line-strong'
                  }`}
                >
                  {f.label} <span className="tabular-nums opacity-70">{n}</span>
                </Link>
              );
            })}
          </div>

          <JobRunList runs={jobs} />

          {jobs.length === PAGE && (
            <p className="px-5 py-3 text-sm text-ink-mute border-t border-line">
              Показано останні {PAGE}. Щоб знайти давніший — звузь фільтром вище.
            </p>
          )}
        </section>

        {/* The debugging escape hatch for "чи бачить фабрика мою зміну" lives
            with the rest of the under-the-hood reading, not on a config page. */}
        <EffectiveConfigPanel />
      </div>
    </div>
  );
}
