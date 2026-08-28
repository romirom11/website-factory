'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Status } from './Status';
import { safeHttpUrl } from '@/lib/format';
import type { DotTone } from '@/lib/humanStatus';
import { startDemoBuild, startDemoBuildBulk, startSocialsDiscoveryBulk } from '@/lib/actions';
import { runWithToast } from '@/lib/toast';
import type { BuildButtonState } from '@/lib/buildPolicy';
import type { SocialsButtonState } from '@/lib/socials';

export interface ListRow {
  id: string;
  name: string;
  /** One human phrase, already composed on the server. */
  statusText: string;
  statusTone: DotTone;
  /** Raw enum, kept only as a tooltip so debugging is still possible. */
  rawStatus: string;
  score: number | null;
  verdictText: string;
  contacts: string[];
  deployUrl: string | null;
  build: BuildButtonState;
  socials: SocialsButtonState;
}

/**
 * The businesses list.
 *
 * A `<table>` with eleven columns was the old shape; on a phone it either
 * scrolled sideways or squeezed every cell to two characters. This is a list of
 * rows instead: name and status always, score and contacts when there is room.
 * Selection (and with it the bulk bar) appears only after the first checkbox —
 * on a normal read there is nothing to look at but names and states.
 */
export function BusinessList({ rows }: { rows: ListRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedRows = rows.filter((r) => selected.has(r.id));
  // `enabled` is already false for disqualified rows, so the bulk count agrees
  // with what each row shows — the count, the row and the card all read the
  // same `availability` and cannot drift apart (sweep P1-1).
  const buildable = selectedRows.filter((r) => r.build.enabled);
  const searchable = selectedRows.filter((r) => r.socials.enabled);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const runOne = (row: ListRow) => {
    // Two different confirms, because they are two different decisions.
    // Overriding a disqualification is Roman disagreeing with the factory's
    // verdict; it must say so rather than reuse the "no gaps" wording.
    if (row.build.availability === 'disqualified') {
      if (!window.confirm(
        `Побудувати демо для «${row.name}» попри вердикт?\n\n`
        + `${row.build.disqualifiedText ?? 'Фабрика вирішила, що демо тут не потрібне'}.\n\n`
        + 'Ти можеш це перекрити — збірка почнеться попри вердикт.',
      )) return;
    } else if (row.build.needsConfirm && !window.confirm(
      `Почати збірку демо для «${row.name}»?\n\n`
      + 'Бізнес у стані «потрібна твоя увага», але всі пропуски закриті — '
      + 'він перейде в «готово до демо» від твого імені.',
    )) return;
    startTransition(() => {
      void runWithToast(() => startDemoBuild(row.id), {
        onResult: () => setSelected((prev) => {
          const n = new Set(prev); n.delete(row.id); return n;
        }),
      });
    });
  };

  const runBulkBuild = () => {
    const ids = buildable.map((r) => r.id);
    if (!ids.length) return;
    const ignored = selected.size - ids.length;
    if (!window.confirm(
      `Почати збірку демо для ${ids.length} бізнесів?`
      + (ignored > 0 ? `\n\n${ignored} з обраних пропустимо — для них збірка зараз неможлива.` : ''),
    )) return;
    // A bulk result enumerates every business it skipped and why, which is more
    // than a toast should hold — so the toast confirms the click and the banner
    // keeps the list to read through afterwards.
    startTransition(() => {
      void runWithToast(() => startDemoBuildBulk(ids), {
        onResult: (res) => { setMessage(res.message); setSelected(new Set()); },
      });
    });
  };

  const runBulkSocials = () => {
    const ids = searchable.map((r) => r.id);
    if (!ids.length) return;
    const ignored = selected.size - ids.length;
    if (!window.confirm(
      `Дошукати соцмережі для ${ids.length} бізнесів?`
      + (ignored > 0 ? `\n\n${ignored} пропустимо: вже знайдені або пошук у черзі.` : ''),
    )) return;
    startTransition(() => {
      void runWithToast(() => startSocialsDiscoveryBulk(ids), {
        onResult: (res) => { setMessage(res.message); setSelected(new Set()); },
      });
    });
  };

  return (
    <section className="card overflow-hidden">
      {/* The bulk bar exists only when something is selected. */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap px-4 py-3 border-b border-line bg-accent-soft">
          <span className="text-sm font-medium">Обрано: {selected.size}</span>
          <button
            type="button"
            className="btn-outline btn-sm"
            disabled={buildable.length === 0 || pending}
            onClick={runBulkBuild}
          >
            Будувати демо ({buildable.length})
          </button>
          <button
            type="button"
            className="btn-outline btn-sm"
            disabled={searchable.length === 0 || pending}
            onClick={runBulkSocials}
          >
            Дошукати соцмережі ({searchable.length})
          </button>
          <button type="button" className="btn-quiet btn-sm ml-auto" onClick={() => setSelected(new Set())}>
            Зняти вибір
          </button>
        </div>
      )}

      {message && (
        <p role="status" className="px-4 py-3 text-sm text-ink-soft border-b border-line bg-paper-sunk">
          {message}
        </p>
      )}

      <ul>
        {rows.map((r) => (
          <li
            key={r.id}
            data-business-id={r.id}
            className="row grid-cols-[auto_1fr] sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]"
          >
            <input
              type="checkbox"
              aria-label={`Обрати ${r.name}`}
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
            />

            <div className="min-w-0">
              {/* The row's own title. Underlined at rest, not on hover: a name
                  that only reveals itself as a link once the pointer is on it
                  is unreachable knowledge on a phone, which has no hover. */}
              <Link href={`/businesses/${r.id}`} className="link font-medium">
                {r.name}
              </Link>
              <div className="mt-0.5">
                <Status tone={r.statusTone} title={r.rawStatus}>{r.statusText}</Status>
              </div>
              {/* On a phone the columns below collapse into this line. */}
              <div className="text-sm text-ink-mute mt-0.5 sm:hidden">
                {[r.score !== null ? `бал ${r.score}` : null, r.verdictText, r.contacts.join(' ')]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>

            <span className="hidden sm:block text-sm text-ink-mute tabular-nums text-right w-12">
              {r.score ?? '—'}
            </span>

            <span className="hidden sm:block text-sm text-ink-mute whitespace-nowrap">
              {r.contacts.join(' ') || '—'}
            </span>

            {/* The action. NOT `hidden sm:flex` any more: that hid the product's
                main verb on the device SPEC §12 names as the target, so on a
                phone the only way to build anything was to tick a checkbox and
                use the bulk bar (sweep P0-4).

                On desktop it sits in its own trailing column. On a phone the
                grid has two columns, so this cell lands on a second line
                spanning under the name — full width, left-aligned, with a real
                44px tap target rather than a squeezed icon. */}
            <span
              className="col-start-2 sm:col-start-auto mt-2 sm:mt-0
                         flex items-center gap-3 flex-wrap
                         justify-start sm:justify-end sm:min-w-[140px]"
            >
              <RowAction row={r} pending={pending} onBuild={() => runOne(r)} />
            </span>
          </li>
        ))}

        {rows.length === 0 && (
          <li className="px-4 py-10 text-center text-ink-mute">
            Нічого не знайшлось. Спробуй прибрати фільтри.
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * The one action on a row, in the state the row is actually in.
 *
 * The old version had exactly two outcomes — a live «Будувати демо» or a greyed
 * one — and used the live variant for a business the factory had explicitly
 * REFUSED to build for, and for a business nobody had ever looked at (sweep
 * P1-1, P1-2). Three visibly different things happen here instead:
 *
 *  - a built demo → a link to it, because that is what you want next;
 *  - disqualified → NO button, the decision written out, and a quiet override
 *    link, because Roman overrules the factory rather than the reverse;
 *  - never checked → a disabled button that says «Ще не перевірено», which is
 *    a different sentence from «пропуски не закриті» and a different sentence
 *    again from an inviting green button.
 */
function RowAction({ row, pending, onBuild }: {
  row: ListRow;
  pending: boolean;
  onBuild: () => void;
}) {
  if (row.deployUrl) {
    return (
      <a
        href={safeHttpUrl(row.deployUrl)}
        target="_blank"
        rel="noreferrer"
        className="link text-sm"
      >
        Демо ↗
      </a>
    );
  }

  if (row.build.availability === 'disqualified') {
    return (
      <>
        <span className="text-sm text-ink-mute">
          {row.build.disqualifiedText ?? 'Демо не потрібне'}
        </span>
        <button
          type="button"
          className="link-quiet text-sm"
          disabled={pending}
          title={row.build.hint}
          onClick={onBuild}
        >
          все одно побудувати
        </button>
      </>
    );
  }

  if (row.build.availability === 'unknown') {
    return (
      <button
        type="button"
        className="btn-quiet btn-sm min-h-[36px]"
        disabled
        title={row.build.hint}
      >
        Ще не перевірено
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn-quiet btn-sm min-h-[36px]"
      disabled={!row.build.enabled || pending}
      title={row.build.hint}
      onClick={onBuild}
    >
      Будувати демо
    </button>
  );
}
