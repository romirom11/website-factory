import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { Badge } from '@/components/Badge';
import { Status } from '@/components/Status';
import { retryJob } from '@/lib/actions';
import { fmtDate, fmtTime, plural, truncate } from '@/lib/format';
import { humanJobLine, humanJobStatus } from '@/lib/humanStatus';
import { stageName } from '@/lib/stageNames';

export interface JobAttemptView {
  id: number;
  sequence: number | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  errorCode: string | null;
  errorDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface JobRunView {
  key: string;
  runId: string | null;
  jobType: string;
  businessId: string | null;
  businessName: string | null;
  campaignId: string | null;
  status: string;
  currentAttemptSequence: number | null;
  duplicateSuppressions: number;
  lastDuplicateAt: Date | null;
  createdAt: Date;
  attempts: JobAttemptView[];
}

function Attempt({ attempt, current }: { attempt: JobAttemptView; current: boolean }) {
  const human = humanJobStatus(attempt.status, attempt.errorCode);
  return (
    <li className="border-t border-line py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-mute tabular-nums">
          {attempt.sequence ? `Спроба #${attempt.sequence}` : 'Legacy attempt'} · ledger #{attempt.id}
          {current && ' · поточна'}
        </span>
        <Status tone={human.tone} title={attempt.status}>
          {humanJobLine(attempt.status, fmtTime(attempt.nextAttemptAt), attempt.errorCode)}
        </Status>
      </div>
      <p className="mt-1 text-xs text-ink-mute">
        створено {fmtDate(attempt.createdAt)}
        {attempt.startedAt ? ` · старт ${fmtDate(attempt.startedAt)}` : ''}
        {attempt.finishedAt ? ` · фініш ${fmtDate(attempt.finishedAt)}` : ''}
        {attempt.attempts > 1 ? ` · pg-boss виконань ${attempt.attempts}` : ''}
      </p>
      {attempt.errorCode && (
        <details className="mt-1">
          <summary className="disclosure text-dot-stop hover:text-dot-stop">
            {attempt.errorCode}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-sm text-ink-mute">
            {truncate(attempt.errorDetail, 600)}
          </pre>
        </details>
      )}
    </li>
  );
}

/** Logical commands with their append-only physical attempt history. */
export function JobRunList({ runs }: { runs: JobRunView[] }) {
  if (runs.length === 0) {
    return <p className="px-5 py-10 text-center text-ink-mute">Немає кроків за цим фільтром.</p>;
  }

  return (
    <ul>
      {runs.map((run) => {
        const current = run.attempts.find((attempt) =>
          run.currentAttemptSequence === null
            ? true
            : attempt.sequence === run.currentAttemptSequence,
        ) ?? run.attempts.at(-1);
        const human = humanJobStatus(run.status, current?.errorCode);
        const canRetry = Boolean(current)
          && ['failed', 'needs_human'].includes(run.status)
          && ['failed', 'needs_human'].includes(current!.status);

        return (
          <li key={run.key} className="row grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium first-letter:uppercase">{stageName(run.jobType)}</span>
                <Status tone={human.tone} title={run.status}>
                  {humanJobLine(run.status, fmtTime(current?.nextAttemptAt), current?.errorCode)}
                </Status>
                {run.duplicateSuppressions > 0 && (
                  <Badge tone="info" title={run.lastDuplicateAt ? `Останній: ${fmtDate(run.lastDuplicateAt)}` : undefined}>
                    дублів пригнічено: {run.duplicateSuppressions}
                  </Badge>
                )}
              </div>

              <div className="mt-1 truncate text-sm text-ink-mute">
                {run.businessId ? (
                  <Link href={`/businesses/${run.businessId}`} title={run.businessId} className="link">
                    {run.businessName ?? run.businessId}
                  </Link>
                ) : (
                  <span className="font-mono">{run.campaignId ?? '—'}</span>
                )}
                {' · '}{fmtDate(run.createdAt)}
                {run.runId && <> · run <span className="font-mono">{run.runId.slice(0, 8)}</span></>}
              </div>

              <details className="mt-2" open={run.status === 'failed' || run.status === 'needs_human'}>
                <summary className="disclosure">
                  {plural(run.attempts.length, 'спроба', 'спроби', 'спроб')}
                  {run.currentAttemptSequence ? ` · поточна #${run.currentAttemptSequence}` : ' · legacy ledger'}
                </summary>
                <ul className="mt-1 rounded-md border border-line bg-paper-sunk px-3">
                  {run.attempts.map((attempt) => (
                    <Attempt
                      key={attempt.id}
                      attempt={attempt}
                      current={run.currentAttemptSequence === null
                        ? attempt.id === current?.id
                        : attempt.sequence === run.currentAttemptSequence}
                    />
                  ))}
                </ul>
              </details>
            </div>

            {canRetry && current && (
              <ActionForm action={retryJob}>
                <input type="hidden" name="jobId" value={current.id} />
                <button type="submit" className="btn-outline btn-sm">Повторити</button>
              </ActionForm>
            )}
          </li>
        );
      })}
    </ul>
  );
}
