'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Status } from './Status';
import type { BuildReviewItem } from '@/lib/inbox';
import type { ActionResult } from '@/lib/types';
import { runWithToast, toastResult } from '@/lib/toast';
import {
  deployBuildAsIs, openBuildPreview, rejectBuild, requestAnotherIteration,
} from '@/lib/buildReviewActions';

/**
 * A demo the critic refused to pass after three tries.
 *
 * The card answers three questions in order, because that is the order Roman
 * decides in: what is this, what does it look like, what do I do about it.
 * The issue list is collapsed by default — eight paragraphs of design critique
 * is what the critic needs, not what a human reads before clicking "show me".
 */
export function BuildReviewCard({ item, showName = true, showDecision = true }: {
  item: BuildReviewItem;
  /** False on the business card, where the page header already names it. */
  showName?: boolean;
  /**
   * False on the business card, where the three decisions are rendered by the
   * header band instead — same component, mounted higher up the page, so they
   * are visible without scrolling. The card below then shows only the evidence.
   */
  showDecision?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'idle' | 'iterate' | 'reject'>('idle');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const showPreview = () => startTransition(async () => {
    const res = await openBuildPreview(item.projectId);
    setResult(res.ok ? null : res);
    // A successful preview needs no toast: the preview itself appears, which is
    // a louder answer than any sentence. A failure has nothing to show.
    if (res.ok && res.url) setPreview(res.url);
    else toastResult(res, 'Preview не відкрився');
  });

  const shipIt = () => {
    if (!window.confirm(
      `Опублікувати демо для «${item.name}» як є?\n\n`
      + 'Критик його не прийняв. Після публікації воно потрапить у Вхідні '
      + 'на підтвердження відправки — саме собою нікому не надішлеться.',
    )) return;
    startTransition(() => {
      void runWithToast(() => deployBuildAsIs(item.projectId), { onResult: setResult });
    });
  };

  const iterate = () => startTransition(() => {
    void runWithToast(() => requestAnotherIteration({ projectId: item.projectId, note }), {
      onResult: (res) => { setResult(res); if (res.ok) { setMode('idle'); setNote(''); } },
    });
  });

  const drop = () => startTransition(() => {
    void runWithToast(() => rejectBuild({ projectId: item.projectId, reason: note }), {
      onResult: (res) => { setResult(res); if (res.ok) setMode('idle'); },
    });
  });

  // Once an action has succeeded the item is gone from the pipeline's point of
  // view; showing its buttons again would invite a second click on a state that
  // no longer exists.
  const done = result?.ok === true;

  return (
    <article className="card overflow-hidden">
      <div className="p-5 sm:p-6">
        <Status tone="wait" className="text-sm">Критик не прийняв збірку</Status>

        {showName && (
          <h2 className="text-xl font-semibold mt-2">
            <Link href={`/businesses/${item.businessId}`} className="link">
              {item.name}
            </Link>
          </h2>
        )}

        <p className={`text-sm text-ink-soft ${showName ? 'mt-1.5' : 'mt-2'}`}>
          {item.qaIterations} спроби виправити, {item.openIssues.length} зауважень лишилось
          {item.wowTotal !== null && <> · оцінка {item.wowTotal} з 18</>}
          {item.score !== null && <> · бал бізнесу {item.score}</>}
        </p>

        <p className="text-sm text-ink-soft mt-3 max-w-[62ch]">
          Фабрика зробила все, що могла, і зупинилась, щоб не показати клієнту слабку роботу.
          Подивись сам: якщо виглядає добре — публікуй, якщо ні — скажи, що поправити.
        </p>

        {/* ── the page itself ── */}
        {preview ? (
          <div className="mt-5">
            <div className="rounded-xl border border-line overflow-hidden bg-white">
              <iframe
                src={preview}
                title={`Збірка ${item.name}`}
                sandbox="allow-scripts allow-same-origin"
                className="w-full bg-white block"
                style={{ height: 460, border: 0 }}
              />
            </div>
            <a
              href={preview}
              target="_blank"
              rel="noreferrer"
              className="link text-sm mt-2"
            >
              Відкрити на весь екран ↗
            </a>
          </div>
        ) : (
          <div className="mt-5">
            <button type="button" className="btn-outline" onClick={showPreview} disabled={pending}>
              {pending ? 'Відкриваю…' : 'Переглянути збірку'}
            </button>
          </div>
        )}

        {/* ── what the critic said, out of the way until asked for ── */}
        {item.openIssues.length > 0 && (
          <details className="mt-5">
            <summary className="disclosure">
              Що не сподобалось критику ({item.openIssues.length})
            </summary>
            <ul className="mt-3 space-y-2.5 max-w-[70ch]">
              {item.openIssues.map((issue, i) => (
                <li key={i} className="text-sm text-ink-soft pl-4 border-l-2 border-line">
                  {issue.replace(/^\[[^\]]+\]\s*/, '')}
                </li>
              ))}
            </ul>
          </details>
        )}

        {item.qaReportKeys.length > 0 && (
          <p className="text-sm mt-3">
            <Link
              href={`/businesses/${item.businessId}/qa/${item.qaReportKeys.length}`}
              className="link"
            >
              Повний звіт перевірки
            </Link>
          </p>
        )}
      </div>

      {/* ── the decision ── */}
      {showDecision && !done && (
        <div className="border-t border-line bg-paper-sunk/50 p-5 sm:p-6">
          {mode === 'idle' && (
            <div className="flex flex-wrap gap-2 items-center">
              <button type="button" className="btn-primary" onClick={shipIt} disabled={pending}>
                Опублікувати як є
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setMode('iterate')}
                disabled={pending}
              >
                Ще спроба
              </button>
              <button
                type="button"
                className="btn-danger ml-auto"
                onClick={() => setMode('reject')}
                disabled={pending}
              >
                Відхилити
              </button>
            </div>
          )}

          {mode === 'iterate' && (
            <div className="space-y-3">
              <label className="label" htmlFor={`note-${item.projectId}`}>
                Що поправити
              </label>
              <textarea
                id={`note-${item.projectId}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                autoFocus
                placeholder="Наприклад: прибрати фото клієнтки у масці, зробити всі фото в одному теплому тоні, додати рух при скролі."
              />
              <p className="text-sm text-ink-mute max-w-[62ch]">
                Це піде агентові як головне завдання — важливіше за зауваження критика.
                Решту сторінки він не чіпатиме.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={iterate}
                  disabled={pending || !note.trim()}
                >
                  {pending ? 'Ставлю в чергу…' : 'Запустити спробу'}
                </button>
                <button type="button" className="btn-quiet" onClick={() => setMode('idle')}>
                  Скасувати
                </button>
              </div>
            </div>
          )}

          {mode === 'reject' && (
            <div className="space-y-3">
              <label className="label" htmlFor={`rej-${item.projectId}`}>
                Чому відхиляєш
              </label>
              <input
                id={`rej-${item.projectId}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
                placeholder="причина — запишеться в історію"
              />
              <p className="text-sm text-ink-mute max-w-[62ch]">
                Бізнес піде у «Відхилено». Зібрані дані і докази лишаються в базі.
              </p>
              <div className="flex gap-2">
                <button type="button" className="btn-danger" onClick={drop} disabled={pending}>
                  {pending ? 'Відхиляю…' : 'Відхилити бізнес'}
                </button>
                <button type="button" className="btn-quiet" onClick={() => setMode('idle')}>
                  Скасувати
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <p
          role="status"
          className={`px-5 sm:px-6 py-3.5 text-sm border-t border-line ${
            result.ok ? 'text-accent bg-accent-soft' : 'text-dot-stop bg-dot-stop/5'
          }`}
        >
          {result.message}
        </p>
      )}
    </article>
  );
}
