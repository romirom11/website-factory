'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Status } from './Status';
import { retryJobAction, startDemoBuild, stopFailedBuildAction } from '@/lib/actions';
import { runWithToast } from '@/lib/toast';
import { stageName } from '@/lib/stageNames';
import { humanStatus } from '@/lib/humanStatus';
import type {
  BusinessReviewItem, InterruptedBuildItem, JobProblemItem, ReplyItem,
} from '@/lib/inbox';
import { CardActionButtons } from './CardActionBar';

/**
 * A build the server restart killed.
 *
 * Roman, 2026-08-22 (BEAUTIFY Laser): a container recreate mid-build left the
 * card claiming «Фабрика будує» over a live log that had stopped moving hours
 * earlier, with no restart button and no notification. The reconciler now fails
 * the orphaned project on the next boot; this is the card that says so.
 *
 * It reuses `startDemoBuild` rather than re-enqueueing the dead job: the job is
 * `stale` bookkeeping and its payload points at a workspace the container no
 * longer has, so resuming it would fail on the missing directory. A fresh build
 * is what «Запустити заново» has always meant on the business card, and this is
 * the same action behind a second door.
 */
/**
 * A business the pipeline parked for Roman's verdict (`business_review`).
 *
 * The card answers his exact question — «де тут мені шо робить?» — in three
 * lines: why the factory stopped, what the decision means, and the buttons.
 * The buttons are `CardActionButtons`, the same component (same confirms, same
 * server actions) the business card's header band presses — one behaviour,
 * two hosts. The name links to the card, which opens on the tab holding the
 * evidence for exactly this reason.
 */
export function BusinessReviewCard({ item }: { item: BusinessReviewItem }) {
  return (
    <article className="card p-5 sm:p-6">
      <Status tone="wait" title={humanStatus(item.status).text}>
        {item.ask === 'fact_check' ? 'Факти не пройшли перевірку' : 'Фабрика чекає твого вердикту'}
      </Status>

      <h2 className="text-lg font-semibold mt-2">
        <Link href={`/businesses/${item.businessId}`} className="link">{item.name}</Link>
        {item.score !== null && (
          <span className="text-sm font-normal text-ink-mute ml-2 tabular-nums">бал {item.score}</span>
        )}
      </h2>

      {item.reason && (
        <p className="text-sm text-ink-soft mt-1.5 max-w-[70ch]">{item.reason}</p>
      )}

      {item.bar.hint && (
        <p className="text-sm text-ink-mute mt-2 max-w-[70ch]">{item.bar.hint}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2.5 items-center">
        <CardActionButtons
          actions={item.bar.actions}
          businessId={item.businessId}
          name={item.name}
          status={item.status}
        />
        <Link href={`/businesses/${item.businessId}`} className="link text-sm">
          Відкрити бізнес →
        </Link>
      </div>
    </article>
  );
}

export function InterruptedBuildCard({ item }: { item: InterruptedBuildItem }) {
  const [started, setStarted] = useState(false);
  const [pending, startTransition] = useTransition();

  const restart = () => startTransition(() => {
    void runWithToast(() => startDemoBuild(item.businessId, { fresh: true }), {
      onResult: (res) => { if (res.ok) setStarted(true); },
    });
  });

  return (
    <article className="card p-5 sm:p-6">
      {/* `wait`, not `stop`: nothing failed and nothing was judged. The build
          was interrupted, which is a thing to redo, not a thing to diagnose. */}
      <Status tone="wait">Збірку перервано</Status>

      <h2 className="text-lg font-semibold mt-2">
        <Link href={`/businesses/${item.businessId}`} className="link">{item.name}</Link>
      </h2>

      <p className="text-sm text-ink-soft mt-1.5 max-w-[70ch]">
        Сервер перезапустився, поки будувався демосайт, і збірка обірвалась на пів дорозі.
        Нічого не втрачено — усе зібране про бізнес на місці, треба лише почати збірку заново.
      </p>

      {started ? (
        <p role="status" className="text-sm text-accent mt-4">
          Збірку поставлено в чергу. Прогрес видно на картці бізнесу.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2 items-center">
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={!item.canRestart || pending}
            title={item.hint}
            onClick={restart}
          >
            {pending ? 'Ставлю в чергу…' : 'Побудувати заново'}
          </button>
          <span className="text-sm text-ink-mute">{item.hint}</span>
        </div>
      )}
    </article>
  );
}

/** A stage that stopped and will not restart itself. */
export function JobProblemCard({ item }: { item: JobProblemItem }) {
  const [open, setOpen] = useState(false);
  // Kept alongside the toast because it also RETIRES the retry button: once a
  // retry is queued, offering the same button again would queue a second one.
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Every step of the demo build: a dead one is restarted from scratch, never
  // «continued» — the old attempt's workspace and project are gone or closed,
  // and re-queuing the same job only produced a green «succeeded» that did
  // nothing (BEAUTIFY Laser, 2026-09-03). A failed publish is the one case
  // where retrying the step itself is cheaper and honest: the site is built.
  const isBuildStep = ['content-and-design', 'build-site', 'deploy-demo'].includes(item.jobType);
  const isPublish = item.jobType === 'deploy-demo';

  const retry = () => startTransition(() => {
    void runWithToast(() => retryJobAction(item.jobId), {
      // Only a SUCCESS retires the button. A failed retry has to stay
      // retryable, or one unreachable moment costs Roman the only control.
      onResult: (res) => { if (res.ok) setMessage(res.message); },
    });
  });

  const rebuild = () => startTransition(() => {
    void runWithToast(() => startDemoBuild(item.businessId!, { fresh: true }), {
      onResult: (res) => { if (res.ok) setMessage('Нова збірка поставлена в чергу. Прогрес — на картці бізнесу.'); },
    });
  });

  const stopBuild = () => {
    const ok = window.confirm(
      `Не будувати демо для «${item.businessName ?? item.businessId}» зараз?\n\n`
      + 'Невдалу спробу буде закрито, а бізнес повернеться у «Готово до демо». '
      + 'Він не стане «Відхиленим» — збірку можна буде запустити пізніше.',
    );
    if (!ok) return;
    startTransition(() => {
      void runWithToast(() => stopFailedBuildAction(item.jobId), {
        onResult: (res) => { if (res.ok) setMessage(res.message); },
      });
    });
  };

  return (
    <article className="card p-5 sm:p-6">
      {/* `actionable` means this step BLOCKS its business and never ages out
          of the inbox — the distinction that stops work quietly leaving the
          to-do list by getting old (audit P1-6). Without rendering it, an item
          that will sit here forever looked identical to one that happened to
          be recent. */}
      <Status tone={item.status === 'failed' ? 'stop' : 'wait'} title={item.status}>
        {isBuildStep
          ? (item.status === 'failed' ? 'Демо: впало' : 'Демо: крок чекає твого рішення')
          : (item.status === 'failed' ? 'Крок упав' : 'Крок чекає твого рішення')}
      </Status>
      {item.actionable && (
        <p className="text-sm text-dot-wait mt-1">
          Бізнес стоїть, поки ти це не вирішиш — саме звідси не зникне.
        </p>
      )}

      <h2 className="text-lg font-semibold mt-2 first-letter:uppercase">{stageName(item.jobType)}</h2>

      <p className="text-sm text-ink-soft mt-1">
        {item.businessId ? (
          <Link href={`/businesses/${item.businessId}`} className="link">
            {item.businessName ?? item.businessId}
          </Link>
        ) : (
          item.campaignId ?? 'без бізнесу'
        )}
        {item.attempts > 1 && <> · спроб: {item.attempts}</>}
      </p>

      {isBuildStep && (
        <p className="text-sm text-ink-mute mt-2 max-w-[70ch]">
          {isPublish
            ? 'Демо зібране, не вдалось лише опублікувати. «Повторити публікацію» спробує ще раз. '
            : 'Ця спроба мертва. «Побудувати заново» почне збірку з нуля — усе зібране про бізнес лишається. '}
          «Не будувати» прибере картку і залишить бізнес готовим до нового запуску — без rejected.
        </p>
      )}

      {!message && (
        <div className="mt-4 flex flex-wrap gap-2 items-center">
          {isBuildStep && !isPublish && item.businessId ? (
            <button type="button" className="btn-primary btn-sm" onClick={rebuild} disabled={pending}>
              {pending ? 'Ставлю в чергу…' : 'Побудувати заново'}
            </button>
          ) : (
            <button type="button" className="btn-outline btn-sm" onClick={retry} disabled={pending}>
              {pending ? 'Виконую…' : isPublish ? 'Повторити публікацію' : 'Повторити'}
            </button>
          )}
          {isBuildStep && (
            <button type="button" className="btn-quiet btn-sm" onClick={stopBuild} disabled={pending}>
              Не будувати
            </button>
          )}
          {(item.errorCode || item.errorDetail) && (
            <button
              type="button"
              className="btn-quiet btn-sm"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? 'Сховати деталі' : 'Деталі'}
            </button>
          )}
        </div>
      )}

      {open && (
        <pre className="mt-3 text-sm text-ink-mute bg-paper-sunk rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono">
          {[item.errorCode, item.errorDetail].filter(Boolean).join('\n\n').slice(0, 1200)}
        </pre>
      )}

      {message && <p role="status" className="text-sm text-accent mt-3">{message}</p>}
    </article>
  );
}

/** Someone answered. The best kind of inbox item. */
export function ReplyCard({ item }: { item: ReplyItem }) {
  return (
    <article className="card p-5 sm:p-6">
      <Status tone="wait">Відповіли</Status>

      <h2 className="text-lg font-semibold mt-2">
        <Link href={`/businesses/${item.businessId}`} className="link">
          {item.name}
        </Link>
      </h2>

      {item.preview && (
        <p className="text-sm text-ink-soft mt-3 pl-4 border-l-2 border-line max-w-[70ch] whitespace-pre-wrap">
          {item.preview}
        </p>
      )}

      <div className="mt-4">
        <Link href={`/businesses/${item.businessId}#rozmova`} className="btn-outline btn-sm no-underline">
          Відкрити розмову
        </Link>
      </div>
    </article>
  );
}
