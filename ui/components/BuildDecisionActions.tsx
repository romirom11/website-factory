'use client';

/**
 * The four answers to "the critic refused this build", as header buttons.
 *
 *   Опублікувати як є   — overrule the critic, deploy this build.
 *   Ще спроба           — one more fix pass IN THIS build, Roman's note first.
 *   Побудувати заново   — throw this build away, new design from scratch.
 *   Відхилити бізнес    — the lead is not worth a demo at all.
 *
 * The third did not exist: «reject» meant the business, so «I want to drop
 * this iteration and just generate the site again» had no button and Roman
 * was left in the «Інше…» dialog guessing which step to requeue (2026-09-15).
 *
 * The same three server actions the inbox card calls — one implementation of the
 * behaviour, two places it can be reached from. On the business card these live
 * in the header band, because Roman's complaint was exactly this: the decision
 * sat at the bottom of a tab full of screenshots, so acting on it meant scrolling
 * past everything he had already read.
 *
 * The two answers that need a sentence from him (another iteration, rejecting the
 * business) open a small form in place. The third publishes, and asks first.
 */

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/types';
import { runWithToast } from '@/lib/toast';
import { deployBuildAsIs, rejectBuild, requestAnotherIteration } from '@/lib/buildReviewActions';
import { startDemoBuild } from '@/lib/actions';

export function BuildDecisionActions({ projectId, businessId, name, onModeChange }: {
  projectId: number;
  businessId: string;
  name: string;
  /** Lets the band drop its general explanation while a form is open. */
  onModeChange?: (open: boolean) => void;
}) {
  const [mode, setModeState] = useState<'idle' | 'iterate' | 'reject'>('idle');
  const setMode = (m: 'idle' | 'iterate' | 'reject') => {
    setModeState(m);
    onModeChange?.(m !== 'idle');
  };
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const done = result?.ok === true;

  const ship = () => {
    if (!window.confirm(
      `Опублікувати демо для «${name}» як є?\n\n`
      + 'Критик його не прийняв. Після публікації воно потрапить у Вхідні '
      + 'на підтвердження відправки — саме собою нікому не надішлеться.',
    )) return;
    startTransition(() => {
      void runWithToast(() => deployBuildAsIs(projectId), { onResult: setResult });
    });
  };

  const iterate = () => startTransition(() => {
    void runWithToast(() => requestAnotherIteration({ projectId, note }), {
      onResult: (res) => { setResult(res); if (res.ok) { setMode('idle'); setNote(''); } },
    });
  });

  const drop = () => startTransition(() => {
    void runWithToast(() => rejectBuild({ projectId, reason: note }), {
      onResult: (res) => { setResult(res); if (res.ok) setMode('idle'); },
    });
  });

  const rebuild = () => {
    if (!window.confirm(
      `Побудувати демо для «${name}» заново?\n\n`
      + 'Ця збірка і зауваження критика підуть в архів. Фабрика зробить новий '
      + 'дизайн з нуля і збере сайт знову — це близько години.',
    )) return;
    startTransition(() => {
      void runWithToast(() => startDemoBuild(businessId, { fresh: true }), { onResult: setResult });
    });
  };

  if (done) {
    return <p role="status" className="text-sm text-accent py-2">{result?.message}</p>;
  }

  return (
    <div className="w-full">
      {mode === 'idle' && (
        <div className="flex items-center gap-2.5 flex-wrap">
          <button type="button" className="btn-primary" onClick={ship} disabled={pending}>
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
          <button type="button" className="btn-outline" onClick={rebuild} disabled={pending}>
            Побудувати заново
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => setMode('reject')}
            disabled={pending}
          >
            Відхилити бізнес
          </button>
        </div>
      )}

      {mode === 'iterate' && (
        <div className="space-y-2.5 max-w-[62ch]">
          <label className="label" htmlFor={`hdr-note-${projectId}`}>Що поправити</label>
          <textarea
            id={`hdr-note-${projectId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Наприклад: прибрати фото у масці, зробити всі фото в одному теплому тоні, додати рух при скролі."
          />
          <p className="text-sm text-ink-mute">
            Це піде агентові як головне завдання — важливіше за зауваження критика.
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
        <div className="space-y-2.5 max-w-[62ch]">
          <label className="label" htmlFor={`hdr-rej-${projectId}`}>Чому відхиляєш</label>
          <input
            id={`hdr-rej-${projectId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
            placeholder="причина — запишеться в історію"
          />
          <p className="text-sm text-ink-mute">
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

      {result && !result.ok && (
        <p role="status" className="text-sm text-dot-stop mt-2.5">{result.message}</p>
      )}
    </div>
  );
}
