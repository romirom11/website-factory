import Link from 'next/link';
import { and, desc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { Status } from '@/components/Status';
import { SystemStatusPanel } from '@/components/SystemStatusPanel';
import { EffectiveConfigPanel } from '@/components/EffectiveConfigPanel';
import { loadSystemStatus } from '@/lib/systemStatus';
import { fmtDate, fmtTime, truncate } from '@/lib/format';
import { humanJobLine, humanJobStatus } from '@/lib/humanStatus';
import { stageName } from '@/lib/stageNames';
import { ActionForm } from '@/components/ActionForm';
import { retryJob } from '@/lib/actions';

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

  const [status_, counts] = await Promise.all([
    loadSystemStatus(),
    db.execute(sql`
      select coalesce(r.status, w.status) as status, count(*)::int as n
      from workflow_jobs w
      left join workflow_job_runs r on r.id = w.run_id
      where w.run_id is null or w.attempt_sequence = r.current_attempt_sequence
      group by coalesce(r.status, w.status)
    `),
  ]);
  const byStatus = new Map(
    (counts.rows as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
  );

  const where: SQL[] = [];
  const logicalStatus = sql<string>`coalesce(${schema.workflowJobRuns.status}, ${schema.workflowJobs.status})`;
  where.push(or(
    isNull(schema.workflowJobs.runId),
    eq(schema.workflowJobs.attemptSequence, schema.workflowJobRuns.currentAttemptSequence),
  )!);
  if (status) where.push(sql`${logicalStatus} = ${status}`);
  if (type) where.push(eq(schema.workflowJobs.jobType, type));

  // 40, not 200: at 200 this page is a 40,000px scroll of mostly-succeeded rows
  // that nobody reads to the end. The filters above are how you find an older
  // one; the list itself is "what happened lately".
  const PAGE = 40;
  const jobs = await db.select({
    ...getTableColumns(schema.workflowJobs),
    logicalRunId: schema.workflowJobRuns.id,
    logicalStatus,
    currentAttemptSequence: schema.workflowJobRuns.currentAttemptSequence,
  }).from(schema.workflowJobs)
    .leftJoin(schema.workflowJobRuns, eq(schema.workflowJobs.runId, schema.workflowJobRuns.id))
    .where(and(...where))
    .orderBy(desc(schema.workflowJobs.createdAt))
    .limit(PAGE);

  // The job list identified businesses by raw id (`gr-patras-abige-hair-nail`),
  // which is the one page-level place the console still asked Roman to read a
  // slug instead of a name (sweep P2-3). One lookup over the ids actually on
  // this page — not a join, because the page is capped at 40 rows anyway.
  const jobBusinessIds = [...new Set(jobs.map((j) => j.businessId).filter((x): x is string => Boolean(x)))];
  const jobBusinessNames = new Map<string, string>(
    jobBusinessIds.length
      ? (await db.select({ id: schema.businesses.id, name: schema.businesses.name })
        .from(schema.businesses)
        .where(inArray(schema.businesses.id, jobBusinessIds)))
        .map((b) => [b.id, b.name])
      : [],
  );

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

          <ul>
            {jobs.map((j) => {
              const human = humanJobStatus(j.logicalStatus);
              return (
                <li key={j.id} className="row grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <span className="text-sm font-medium first-letter:uppercase">{stageName(j.jobType)}</span>
                    <div className="mt-0.5">
                      <Status tone={human.tone} title={j.logicalStatus}>
                        {humanJobLine(j.logicalStatus, fmtTime(j.nextAttemptAt))}
                      </Status>
                    </div>
                    <div className="text-sm text-ink-mute mt-0.5 truncate">
                      {j.businessId ? (
                        <Link href={`/businesses/${j.businessId}`} title={j.businessId} className="link">
                          {jobBusinessNames.get(j.businessId) ?? j.businessId}
                        </Link>
                      ) : (
                        <span className="font-mono">{j.campaignId ?? '—'}</span>
                      )}
                      {' · '}{fmtDate(j.createdAt)}
                      {j.attempts > 1 && <> · спроб {j.attempts}</>}
                      {j.logicalRunId && (
                        <> · run <span className="font-mono">{j.logicalRunId.slice(0, 8)}</span>
                          {' · '}attempt {j.attemptSequence ?? j.currentAttemptSequence} · ledger #{j.id}</>
                      )}
                    </div>
                    {j.status !== j.logicalStatus && (
                      <p className="mt-0.5 text-xs text-ink-mute">
                        Фізична attempt: {humanJobLine(j.status, fmtTime(j.nextAttemptAt))}
                      </p>
                    )}
                    {j.errorCode && (
                      <details className="mt-1">
                        <summary className="disclosure text-dot-stop hover:text-dot-stop">
                          {j.errorCode}
                        </summary>
                        <pre className="text-sm text-ink-mute mt-1 whitespace-pre-wrap font-mono">
                          {truncate(j.errorDetail, 600)}
                        </pre>
                      </details>
                    )}
                  </div>
                  {['failed', 'needs_human'].includes(j.logicalStatus) && ['failed', 'needs_human'].includes(j.status) && (
                    <ActionForm action={retryJob}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <button type="submit" className="btn-outline btn-sm">Повторити</button>
                    </ActionForm>
                  )}
                </li>
              );
            })}
            {jobs.length === 0 && (
              <li className="px-5 py-10 text-center text-ink-mute">Немає кроків за цим фільтром.</li>
            )}
          </ul>

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
