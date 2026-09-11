'use client';

/**
 * The band of buttons under the business's name.
 *
 * This is the answer to "what do I do with this one", and it is above every tab
 * on purpose: previously the decision buttons were at the bottom of a tab full of
 * screenshots, so you read four screens before you could act, and once you got
 * there nothing looked pressable.
 *
 * Three rules hold this together:
 *  - WHICH actions appear is decided in `lib/cardActions.ts` from the state, on
 *    the server. This file only draws them.
 *  - A button looks like a button (fill or border, hover, pointer). A link that
 *    navigates away looks like a link (underline). Nothing in between.
 *  - When there is nothing to press the band says what the factory is doing
 *    instead of showing a greyed-out control. A disabled button that never
 *    becomes enabled is an unanswered question.
 *
 * Sticky on a phone: the band stays under the toolbar while the tabs scroll, so
 * the action never leaves the screen. On desktop it scrolls away normally,
 * because the whole header fits above the fold anyway.
 */

import { useState, useTransition } from 'react';
import {
  resolveBusinessReviewAction, startDemoBuild, startSocialsDiscovery,
} from '@/lib/actions';
import { runWithToast } from '@/lib/toast';
import { BuildDecisionActions } from './BuildDecisionActions';
import type { CardAction, CardActionBar as Bar } from '@/lib/cardActions';

/**
 * `link` used to map to the empty string, which drew an unstyled <button> —
 * browser-default chrome on a page that has none. A link-KIND action that is
 * not a navigation is still a click, so it wears `.link`.
 */
const KIND_CLASS: Record<CardAction['kind'], string> = {
  primary: 'btn-primary',
  secondary: 'btn-outline',
  danger: 'btn-danger',
  link: 'link text-sm',
};

/**
 * The action row itself — the buttons with their confirms and pending state.
 *
 * Separate from the band because the band is one PLACE these actions render;
 * the inbox's business-review card is another. Both must press identically
 * (same confirms, same server actions), so the behaviour lives once, here,
 * and the two hosts only decide the framing around it.
 */
export function CardActionButtons({ actions, businessId, name, status }: {
  actions: CardAction[];
  businessId: string;
  name: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();

  const runBuild = (action: CardAction) => {
    // Overriding a disqualification is a different decision from clearing the
    // last gap, and it gets its own sentence: the factory said no, and this
    // click says otherwise (sweep P1-1).
    if (action.label.startsWith('Все одно')) {
      const ok = window.confirm(
        `Побудувати демо для «${name}» попри вердикт фабрики?\n\n`
        + 'Фабрика вирішила, що демо тут не потрібне. Ти це перекриваєш — '
        + 'збірка почнеться попри вердикт.',
      );
      if (!ok) return;
    } else if (status === 'needs_review' && !action.disabledReason) {
      // Building from `needs_review` also moves the business to
      // production_ready under Roman's name, which lands in status_history.
      // That never happens on an accidental click.
      const ok = window.confirm(
        `Побудувати демо для «${name}»?\n\n`
        + 'Бізнес чекав на твою увагу. Пропусків, які блокують, немає, '
        + 'тож він перейде в «Готово до демо» від твого імені і почнеться збірка.',
      );
      if (!ok) return;
    }
    // The outcome goes to the toast rather than to a line under the band: on a
    // phone the band is sticky and the sentence used to land off-screen under
    // it, and the page revalidates on success anyway, which wipes local state.
    const mode = action.run === 'build' ? action.mode : undefined;
    startTransition(() => {
      void runWithToast(() => startDemoBuild(businessId, { fresh: mode === 'fresh', resume: mode === 'resume' }));
    });
  };

  const runSocials = () => startTransition(() => {
    void runWithToast(() => startSocialsDiscovery(businessId));
  });

  const runBusinessReview = (action: Extract<CardAction, { run: 'business-review' }>) => {
    if (action.decision === 'close') {
      const ok = window.confirm(
        `Не брати «${name}» у роботу?\n\n`
        + 'Бізнес буде закрито без статусу «Відхилено». '
        + 'Фабрика не будуватиме демо і не контактуватиме з ним.',
      );
      if (!ok) return;
    }
    startTransition(() => {
      void runWithToast(() => resolveBusinessReviewAction({
        businessId,
        decision: action.decision,
      }));
    });
  };

  const runAction = (action: CardAction) => {
    if (action.run === 'build') runBuild(action);
    else if (action.run === 'socials') runSocials();
    else if (action.run === 'business-review') runBusinessReview(action);
  };

  return (
    <>
      {actions.map((action, i) => (
        <ActionControl
          key={`${action.label}-${i}`}
          action={action}
          pending={pending}
          onRun={() => runAction(action)}
        />
      ))}
    </>
  );
}

export function CardActionBar({ bar, businessId, name, status, other }: {
  bar: Bar;
  businessId: string;
  name: string;
  status: string;
  /** The «Інше…» link, rendered by the server component that owns the forms. */
  other: React.ReactNode;
}) {
  // While a decision form is open the general "here are your three options"
  // sentence is stale advice — you have already picked one.
  const [formOpen, setFormOpen] = useState(false);

  // The hint shown under the band belongs to the primary action — the one whose
  // consequence a person needs spelled out before pressing.
  const lead = bar.actions.find((a) => a.kind === 'primary') ?? bar.actions[0];


  // Shown next to the actions on arrival, and (on a phone) dropped once the band
  // sticks — three lines of prose riding at the top of a 844px screen would eat
  // half of it. Rendered twice with complementary breakpoints rather than once,
  // because "hide only while stuck" has no CSS expression.
  const explanation = bar.hint ?? lead?.disabledReason ?? lead?.hint;
  const showExplanation = Boolean(
    (bar.decision || bar.actions.length > 0) && explanation && !formOpen,
  );
  const explanationTone = lead?.disabledReason ? 'text-dot-wait' : 'text-ink-mute';

  return (
    <>
      {/* top-14 == the nav's own h-14. The nav is itself `sticky top-0 z-20`, so a
          band sticking to 0 would slide underneath it and vanish; z-10 keeps this
          one below the nav and above the page. Sticky on a phone only: on desktop
          the whole header fits above the fold already. */}
      <div
        // `z-10` put the band ABOVE the tab strip it scrolls over, so on a
        // phone the sticky band sat on top of «Демо / Контакти / Факти…» and
        // swallowed the taps — the tabs were unreachable below `sm`. z-0 keeps
        // it above the page background (which is all it ever needed) and below
        // anything the reader has to touch.
        className="sticky top-14 z-0 sm:static mb-7 bg-paper-sunk/95 backdrop-blur-sm
                   sm:backdrop-blur-none border-y border-line -mx-4 px-4 sm:mx-0
                   sm:rounded-xl sm:border py-3.5 sm:px-5"
      >
        {/* The actions and «Інше…» are separate flex children so a wrapping row of
            buttons cannot push the link onto a line of its own. */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5 flex-wrap min-w-0">
            {/* A refused build is a decision with forms attached, not a row of
                labels — that one state hands the row to its own component. */}
            {bar.decision
              ? (
                <BuildDecisionActions
                  projectId={bar.decision.projectId}
                  name={name}
                  onModeChange={setFormOpen}
                />
              )
              : (
                <CardActionButtons
                  actions={bar.actions}
                  businessId={businessId}
                  name={name}
                  status={status}
                />
              )}

            {!bar.decision && bar.actions.length === 0 && bar.waiting && (
              <p className="text-sm text-ink-soft max-w-[62ch] py-1">{bar.waiting}</p>
            )}
          </div>

          {/* `pt-2.5` used to nudge a bare text link onto the buttons' baseline.
              «Інше…» is a real btn-sm now, so it aligns on its own box. */}
          <div className="shrink-0">{other}</div>
        </div>

        {showExplanation && (
          <p className={`text-sm mt-2.5 max-w-[70ch] hidden sm:block ${explanationTone}`}>
            {explanation}
          </p>
        )}

        {bar.actions.length > 0 && bar.waiting && (
          <p className="text-sm text-ink-soft mt-2.5 max-w-[70ch]">{bar.waiting}</p>
        )}
      </div>

      {showExplanation && (
        <p className={`text-sm mb-7 -mt-4 sm:hidden ${explanationTone}`}>{explanation}</p>
      )}
    </>
  );
}

function ActionControl({ action, pending, onRun }: {
  action: CardAction;
  pending: boolean;
  onRun: () => void;
}) {
  const disabled = Boolean(action.disabledReason) || pending;
  const label = pending && action.run !== 'href' ? 'Виконую…' : action.label;

  if (action.run === 'href') {
    // Navigation is a link, and it says so. `external` opens the demo in its own
    // tab; an internal jump (to Вхідні) stays in this one.
    const primaryish = action.kind === 'primary';
    return (
      <a
        href={action.href}
        {...(action.external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className={primaryish ? 'btn-primary' : 'link text-sm'}
      >
        {action.label}
        {action.external ? ' ↗' : primaryish ? ' →' : ''}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={KIND_CLASS[action.kind]}
      disabled={disabled}
      title={action.disabledReason ?? action.hint}
      onClick={onRun}
    >
      {label}
    </button>
  );
}
