'use client';

/**
 * The three manual overrides, behind one small link called «Інше…».
 *
 * They used to be a block at the very bottom of the card labelled «Ручні дії» —
 * a phrase that says nothing about what happens, sitting under a heading nobody
 * reads. All three are still here and still do exactly what they did. What
 * changed:
 *
 *  - the entry point is one text link in the header, next to the real actions,
 *    so it is findable without scrolling and obviously not the main thing;
 *  - each control is named by its effect and carries one sentence explaining it;
 *  - the permanent block asks for a typed-out confirm, because it is the only
 *    action on this card that cannot be undone.
 *
 * A native <dialog> rather than a hand-rolled overlay: Escape, focus trapping and
 * the backdrop come from the browser, and the whole thing is inert until opened.
 *
 * Every form CLOSES the dialog on success and reports through a toast (Roman,
 * 2026-08-22). Before, a successful submit left the dialog sitting open over an
 * already-updated page with no acknowledgement at all — the strongest possible
 * signal that nothing happened, on the screen where the least reversible action
 * in the console lives.
 */

import { useRef } from 'react';
import { ActionForm } from './ActionForm';
import { forceStatusAction, markDoNotContact, reenqueueStage } from '@/lib/actions';
import { humanStatus } from '@/lib/humanStatus';
import { stageName } from '@/lib/stageNames';
import { MANUAL_REQUEUE_JOB_NAMES } from '@factory/jobDefinitions';

export function OtherActionsDialog({ businessId, name, currentStatus, statuses }: {
  businessId: string;
  name: string;
  currentStatus: string;
  statuses: string[];
}) {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      {/* It opens a dialog, so it is a control, not a navigation — `btn-quiet`
          rather than `.link`. Tertiary weight keeps it out of the way of the
          real action beside it while still being unmistakably pressable. */}
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className="btn-quiet btn-sm"
      >
        Інше…
      </button>

      <dialog
        ref={ref}
        // `max-h` + `overflow-y-auto` on the <dialog> itself left the last
        // section (the destructive one) cut off with no way to scroll to it
        // (sweep P2-2). The dialog is now a flex COLUMN that is at most 85vh
        // tall, its header is fixed, and the body is the scroll container — so
        // the bottom of the last form is always reachable.
        // `open:flex`, NOT a bare `flex`. A closed <dialog> is hidden by the UA
        // stylesheet's `display: none`, and any `display` utility of ours wins
        // over it — a plain `flex` here renders the whole dialog inline on the
        // page at all times. The layout it needs only applies when it is open.
        className="card p-0 w-[min(100vw-2rem,560px)] max-h-[85dvh] overflow-hidden
                   open:flex flex-col backdrop:bg-ink/25 shadow-pop m-auto"
        onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
      >
        <div className="flex items-baseline justify-between gap-4 px-5 sm:px-6 pt-5 pb-4
                        border-b border-line shrink-0">
          <div>
            <h2 className="h-section">Інші дії</h2>
            <p className="text-sm text-ink-mute mt-1">
              Рідкісні речі, які фабрика зазвичай робить сама. Усе записується в історію від твого імені.
            </p>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="btn-quiet shrink-0 -mr-2"
            aria-label="Закрити"
          >
            ✕
          </button>
        </div>

        <div className="p-5 sm:p-6 space-y-7 overflow-y-auto min-h-0 flex-1">
          {/* ── 1: force a status ── */}
          <ActionForm
            action={forceStatusAction}
            className="space-y-2.5"
            onDone={() => ref.current?.close()}
          >
            <input type="hidden" name="businessId" value={businessId} />
            <h3 className="text-base font-medium text-ink">Перевести в інший стан</h3>
            <p className="text-sm text-ink-soft">
              Ставить бізнес у стан, який ти вибереш, обходячи звичайний порядок.
              Потрібно, коли фабрика застрягла або помилилась.
            </p>
            <div className="grid sm:grid-cols-2 gap-2.5">
              <label className="block">
                <span className="label">Новий стан</span>
                <select id="to" name="to" defaultValue={currentStatus}>
                  {statuses.map((s) => (
                    <option key={s} value={s}>{humanStatus(s).text}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Причина</span>
                <input name="reason" placeholder="навіщо переводиш" required />
              </label>
            </div>
            <button type="submit" className="btn-outline btn-sm">Перевести</button>
          </ActionForm>

          {/* ── 2: re-run a stage ── */}
          <ActionForm
            action={reenqueueStage}
            className="space-y-2.5 pt-7 border-t border-line"
            onDone={() => ref.current?.close()}
          >
            <input type="hidden" name="businessId" value={businessId} />
            <h3 className="text-base font-medium text-ink">Перезапустити крок</h3>
            <p className="text-sm text-ink-soft">
              Ставить один крок конвеєра в чергу ще раз — у ту саму чергу, що й автоматичні.
              Результат перезапише те, що цей крок зробив минулого разу.
            </p>
            <label className="block">
              <span className="label">Який крок</span>
              <select id="job" name="job" defaultValue="request-approval">
                {MANUAL_REQUEUE_JOB_NAMES.map((s) => (
                  <option key={s} value={s}>{stageName(s)}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-outline btn-sm">Поставити в чергу</button>
          </ActionForm>

          {/* ── 3: the one that cannot be undone ── */}
          <ActionForm
            action={markDoNotContact}
            className="space-y-2.5 pt-7 border-t border-line"
            onDone={() => ref.current?.close()}
            confirm={() => window.confirm(
              `Більше ніколи не писати «${name}»?\n\n`
              + 'Бізнес і всі його адреси стануть заблокованими назавжди. '
              + 'Це перевіряється в момент відправки, тож жодне повідомлення до нього не піде. '
              + 'Скасувати це з інтерфейсу не можна.',
            )}
          >
            <input type="hidden" name="businessId" value={businessId} />
            <h3 className="text-base font-medium text-dot-stop">
              Більше ніколи не писати цьому бізнесу
            </h3>
            <p className="text-sm text-ink-soft">
              Назавжди блокує бізнес і всі його адреси — пошта, телефон, месенджери.
              Перевіряється в момент відправки, тож нічого не піде навіть випадково.
              Скасувати з інтерфейсу не можна.
            </p>
            <label className="block">
              <span className="label">Причина</span>
              <input id="dnc-reason" name="reason" placeholder="чому блокуєш" />
            </label>
            {/* The one irreversible action in the console, so it is the one
                place a bordered danger button is right: `btn-danger` alone is
                a text-weight control, and this must not look like «Скасувати».
                The border is the only addition — colour and hover come from
                the shared class. */}
            <button
              type="submit"
              className="btn-danger btn-sm border-dot-stop hover:bg-dot-stop hover:text-white"
            >
              Заблокувати назавжди
            </button>
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
