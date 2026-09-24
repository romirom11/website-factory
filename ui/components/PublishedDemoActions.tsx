'use client';

/**
 * What Roman can do with a PUBLISHED demo he found a bug on.
 *
 *   Виправити демо     — his note becomes the brief of one fix round over the
 *                        same build; the critic republishes under the same URL
 *                        or hands the build back to him.
 *   Побудувати заново  — throw the build away, new design from scratch.
 *
 * Sits next to «Підтвердити відправку» and «Відкрити демо»: publishing is not
 * the end of editing, and the send stays a separate decision.
 */

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/types';
import { runWithToast } from '@/lib/toast';
import { fixPublishedDemo, startDemoBuild } from '@/lib/actions';

export function PublishedDemoActions({ projectId, businessId, name }: {
  projectId: number;
  businessId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const fix = () => startTransition(() => {
    void runWithToast(() => fixPublishedDemo({ businessId, projectId, note }), {
      onResult: (res) => { setResult(res); if (res.ok) { setOpen(false); setNote(''); } },
    });
  });

  const rebuild = () => {
    if (!window.confirm(
      `Побудувати демо для «${name}» заново?\n\n`
      + 'Опубліковане демо лишиться доступним за своєю адресою, поки не опублікується нове. '
      + 'Фабрика зробить новий дизайн з нуля і збере сайт знову — це близько години.',
    )) return;
    startTransition(() => {
      void runWithToast(() => startDemoBuild(businessId, { fresh: true }), { onResult: setResult });
    });
  };

  if (result?.ok) {
    return <p role="status" className="text-sm text-accent py-2">{result.message}</p>;
  }

  return (
    <div className="w-full">
      {!open && (
        <div className="flex items-center gap-2.5 flex-wrap">
          <button type="button" className="btn-outline" onClick={() => setOpen(true)} disabled={pending}>
            Виправити демо
          </button>
          <button type="button" className="btn-quiet" onClick={rebuild} disabled={pending}>
            Побудувати заново
          </button>
        </div>
      )}

      {open && (
        <div className="space-y-2.5 max-w-[62ch]">
          <label className="label" htmlFor={`fix-note-${projectId}`}>Що поправити</label>
          <textarea
            id={`fix-note-${projectId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Наприклад: у футері не той телефон; на мобільному галерея вилазить за екран."
          />
          <p className="text-sm text-ink-mute">
            Агент поправить рівно це в тій самій збірці, критик перевірить, і демо оновиться на тій самій
            адресі. Поки він працює, стара версія лишається доступною.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={fix} disabled={pending || !note.trim()}>
              {pending ? 'Ставлю в чергу…' : 'Запустити правку'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => setOpen(false)}>
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
