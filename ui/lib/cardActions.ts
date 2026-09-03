/**
 * What can I DO with this business right now — one answer, one place.
 *
 * Roman's complaint about the previous card: the buttons lived at the bottom,
 * under a tab full of screenshots, so deciding anything meant scrolling past
 * everything you had already read. And once you got there you could not tell a
 * button from a sentence.
 *
 * The fix is not a bigger button. It is that the card knows, for the state the
 * business is actually in, which one-to-three things a person would want to do —
 * and says only those, at the top, before any of the reading material.
 *
 * This module is that knowledge, and it is the ONLY copy of it. The header band
 * renders what this returns; nothing else on the card invents an action of its
 * own. If a state ever needs a fourth action, that is a sign the state means two
 * different things and should be split, not that this list should grow.
 *
 * Deliberately data, not JSX: the decision "which actions" is made on the server
 * from the same inputs the server actions themselves check, so the card can never
 * offer something the action would refuse. The header maps each descriptor onto
 * the client component that performs it.
 */

import type { BuildButtonState } from './buildPolicy';
import type { SocialsButtonState } from './socials';
import { reviewAsk } from './humanStatus';

/**
 * How an action looks, which is also what it means.
 *
 * `primary` — the thing to do, at most one per card.
 * `secondary` — a real alternative, still a button.
 * `danger` — ends this business's road; always behind a confirm.
 * `link` — leaves the card (opens the demo, jumps to Вхідні). Looks like a link
 *   because it behaves like one; a filled button that navigates away is a lie.
 */
export type CardActionKind = 'primary' | 'secondary' | 'danger' | 'link';

/**
 * Which component actually performs the action.
 *
 * The header switches on this. Three of them are existing client components with
 * their own confirm dialogs and pending states (`build`, `socials`,
 * `build-review`); the rest are plain navigation.
 */
export type CardActionRun =
  | { run: 'build' }
  | { run: 'socials' }
  | { run: 'business-review'; decision: 'recollect_facts' | 'close' }
  | { run: 'href'; href: string; external?: boolean };

export type CardAction = CardActionRun & {
  /** Verb, in Roman's words. Never a noun, never a state name. */
  label: string;
  kind: CardActionKind;
  /** One line under the band explaining what pressing it does. Optional. */
  hint?: string;
  /** When set, the control renders disabled and this says why. */
  disabledReason?: string;
};

export interface CardActionBar {
  /**
   * Set when the actions for this state are a decision form rather than plain
   * buttons — the build the critic refused. The header renders the dedicated
   * component; `actions` stays empty.
   */
  decision?: { projectId: number };
  /** One line under the row, when the state needs explaining but has no primary. */
  hint?: string;
  /**
   * What the factory is doing right now, when it is doing something and there is
   * nothing to press. A state like `site_in_progress` gets THIS and no buttons —
   * an empty band with a sentence is the honest answer, and much better than a
   * greyed-out button that invites clicking.
   */
  waiting: string | null;
  actions: CardAction[];
}

export interface CardActionInput {
  businessId: string;
  status: string;
  /** State of the newest site project, if any. */
  projectState: string | null | undefined;
  projectId: number | null | undefined;
  /** Public URL of a deployed demo, if there is one. */
  deployUrl: string | null | undefined;
  /** Precomputed on the server — the same verdict `startDemoBuild` would reach. */
  build: BuildButtonState;
  socials: SocialsButtonState;
  /** Unresolved hard gaps, i.e. the reasons the readiness gate said no. */
  openGaps: string[];
  /** True when the missing thing is specifically social profiles. */
  socialsGap: boolean;
  /** True when this business has a row waiting in Вхідні. */
  hasPendingApproval: boolean;
  /**
   * `businesses.status_reason` — the same string `humanReasonForHeader` prints.
   * `needs_review` is a catch-all, and WHICH review is being asked for lives
   * only here; without it the band offers «Побудувати демо» with no hint of
   * what the person is supposed to have reviewed first (Roman, 2026-08-23:
   * «Де моя увага треба?» — на картці, що чекала рішення по фактчеку).
   */
  statusReason: string | null | undefined;
}

/**
 * Is this `needs_review` specifically the stage-8 fact-check saying no?
 *
 * Exported so the business page can open on the «Факти й джерела» tab with the
 * critic's report unfolded — the thing this status is asking a person to read.
 * The reason classification itself lives in `humanStatus.reviewAsk`, next to
 * the rest of the status_reason semantics.
 */
export function isFactCheckAttention(status: string, statusReason: string | null | undefined): boolean {
  return status === 'needs_review' && reviewAsk(statusReason) === 'fact_check';
}

/**
 * The actions for one business, most important first.
 *
 * Read as a sentence per state: "a demo the critic refused → look at it, then
 * decide"; "a demo that shipped → open it, then approve the send"; "nothing
 * built and nothing missing → build it".
 */
export function cardActionBar(input: CardActionInput): CardActionBar {
  const {
    status, projectState, projectId, deployUrl, build, socials,
    openGaps, socialsGap, hasPendingApproval,
  } = input;

  const openDemo = (label: string): CardAction | null => deployUrl
    ? { run: 'href', href: deployUrl, external: true, label, kind: 'link' }
    : null;

  const approve: CardAction = {
    run: 'href',
    href: `/inbox?business=${encodeURIComponent(input.businessId)}`,
    label: 'Підтвердити відправку',
    kind: 'primary',
    hint: 'Показує лист і канал у Вхідних. Без твого «так» ніхто нічого не надішле.',
  };

  // ── a build that stopped and is waiting for a person ──────────────────────
  // Ranked first regardless of business status: this is the one case where the
  // factory has genuinely stopped and cannot continue without an answer.
  if (projectState === 'needs_human_review' && projectId) {
    return {
      // The three decisions are rendered by `BuildDecisionActions`, which the
      // header mounts in place of the button row — they need forms, not labels.
      decision: { projectId },
      waiting: null,
      actions: [],
      hint: 'Критик не прийняв демо за 3 спроби. Подивись збірку в «Демо» нижче '
        + 'і вирішуй: публікувати як є, дати ще одну спробу чи відхилити бізнес.',
    };
  }

  if (projectState === 'failed') {
    // The failed row can be the previous attempt while its automatic
    // replacement is already queued/running/retry_wait. In that overlap there
    // is nothing to restart: a button (even disabled) makes an automatic
    // recovery look like Roman's unresolved task.
    if (build.availability === 'busy') {
      return {
        waiting: `${build.hint}. Фабрика продовжить сама; нічого натискати не треба.`,
        actions: [],
      };
    }
    return {
      waiting: null,
      actions: [{
        run: 'build',
        label: 'Побудувати заново',
        kind: 'primary',
        hint: build.hint,
        disabledReason: build.enabled ? undefined : build.hint,
      }],
    };
  }

  // ── the demo is built and the send is the next human decision ─────────────
  if (status === 'site_ready' || (hasPendingApproval && status !== 'contacted')) {
    return {
      waiting: null,
      actions: [approve, openDemo('Відкрити демо')].filter(Boolean) as CardAction[],
    };
  }

  // ── the factory is mid-flight; nothing to press, only something to know ───
  if (status === 'site_in_progress' || isBusyProject(projectState)) {
    return {
      waiting: projectState === 'qa'
        ? 'Демо зібране, зараз його перевіряє критик. Коли закінчить — тут з’явиться рішення.'
        : 'Фабрика будує демосайт. Це займає 10–30 хвилин; сторінку можна закрити.',
      actions: [],
    };
  }

  // ── ready to build ────────────────────────────────────────────────────────
  if (status === 'production_ready') {
    return {
      waiting: null,
      actions: [{
        run: 'build',
        label: 'Побудувати демо',
        kind: 'primary',
        hint: build.hint,
        disabledReason: build.enabled ? undefined : build.hint,
      }],
    };
  }

  // ── the factory decided there is no opportunity here ──────────────────────
  // Ranked before the gap logic: a disqualification is not a gap to be closed,
  // it is a verdict about the business. Offering «Побудувати демо» as the
  // primary action next to it presents a refusal as readiness (sweep P1-1).
  // The override still exists — Roman overrules the factory, not the reverse —
  // but as a quiet link, and the card states the decision first.
  if (build.availability === 'disqualified') {
    return {
      waiting: null,
      hint: `${build.disqualifiedText ?? 'Фабрика вирішила, що демо тут не потрібне'}. `
        + 'Якщо вважаєш інакше — можна побудувати попри вердикт.',
      actions: [
        {
          run: 'build',
          label: 'Все одно побудувати демо',
          kind: 'secondary',
          hint: build.hint,
        },
        ...(openDemo('Відкрити демо') ? [openDemo('Відкрити демо')!] : []),
      ],
    };
  }

  // ── nothing has been checked yet ──────────────────────────────────────────
  // Not the same as "no gaps": there is no evidence at all, so there is nothing
  // a demo could honestly be built from (sweep P1-2).
  if (build.availability === 'unknown') {
    return {
      waiting: 'Фабрика ще не збирала дані по цьому бізнесу — ні фактів, ні контактів. '
        + 'Демо будувати нема з чого.',
      actions: [],
    };
  }

  // ── the gate refused, and the reason decides what to offer ────────────────
  if (status === 'needs_review') {
    const actions: CardAction[] = [];
    const ask = reviewAsk(input.statusReason);

    // The fact-check said no. The decision being asked for is «прочитай звіт
    // критика і вирішуй», so the band SAYS that — otherwise the only visible
    // action is a build button and the review this status asks for is a
    // folded panel two tabs away.
    const factCheckHint = ask === 'fact_check'
      ? (/unavailable/i.test(input.statusReason ?? '')
        ? 'Факти ніхто незалежно не перевірив — перевіряльник був недоступний. '
          + 'Переглянь «Факти й джерела» і обери: прийняти їх, зібрати заново або не брати бізнес у роботу.'
        : 'Критик не прийняв факти — його звіт відкритий у «Факти й джерела» нижче. '
          + 'Обери: прийняти факти, зібрати їх заново або не брати бізнес у роботу.')
      : undefined;

    // A missing social profile is the gap Roman can close with one click, so it
    // leads. Every other gap needs a person to go and find something.
    if (!['fact_check', 'verdict'].includes(ask)
      && (socialsGap || (openGaps.length > 0 && socials.enabled))) {
      actions.push({
        run: 'socials',
        label: 'Дошукати соцмережі',
        kind: openGaps.length > 0 ? 'primary' : 'secondary',
        hint: socials.hint,
        disabledReason: socials.enabled ? undefined : socials.hint,
      });
    }

    actions.push({
      run: 'build',
      label: ask === 'fact_check' ? 'Факти правильні — будувати' : 'Побудувати демо',
      kind: actions.length ? 'secondary' : 'primary',
      hint: build.hint,
      disabledReason: build.enabled ? undefined : build.hint,
    });

    // A review is only a decision when every outcome is reachable from the
    // card. Previously “critic says facts are wrong” still offered only Build,
    // so agreeing with the critic had no action and the item could never leave.
    if (ask === 'fact_check' || ask === 'verdict') {
      actions.push({
        run: 'business-review',
        decision: 'recollect_facts',
        label: ask === 'fact_check' ? 'Перезібрати факти' : 'Перезібрати дані',
        kind: 'secondary',
        hint: 'Фабрика заново збере джерела, факти й перевірить їх.',
      });
      actions.push({
        run: 'business-review',
        decision: 'close',
        label: 'Не брати в роботу',
        kind: 'danger',
        hint: 'Закриє цей бізнес без статусу «Відхилено» і без будь-якого контакту.',
      });
    }

    return { waiting: null, hint: factCheckHint, actions };
  }

  // ── after the send: the demo, if there is one, and nothing else ───────────
  if (['outreach_approved', 'contacted', 'replied', 'meeting', 'proposal', 'won']
    .includes(status)) {
    const demo = openDemo('Відкрити демо');
    return {
      waiting: status === 'contacted'
        ? 'Лист пішов. Відповідь з’явиться у «Розмові» і у Вхідних.'
        : null,
      actions: demo ? [demo] : [],
    };
  }

  // ── the road ended ────────────────────────────────────────────────────────
  if (['rejected', 'lost', 'closed', 'duplicate', 'do_not_contact'].includes(status)) {
    return {
      waiting: 'Цей бізнес закритий. Дані лишаються в базі, але фабрика ним більше не займається.',
      actions: openDemo('Відкрити демо') ? [openDemo('Відкрити демо')!] : [],
    };
  }

  // ── early stages the pipeline walks by itself ─────────────────────────────
  return {
    waiting: EARLY_WAITING[status]
      ?? 'Фабрика веде цей бізнес по конвеєру. Коли знадобиться твоє рішення — воно буде тут.',
    actions: [],
  };
}

const EARLY_WAITING: Record<string, string> = {
  discovered: 'Щойно знайшли. Фабрика ще не бралась за нього — далі буде відбір і збір даних.',
  prequalified: 'Пройшов первинний відбір. Далі фабрика збирає дані та фото.',
  enriching: 'Збираємо дані: контакти, соцмережі, фото, стан їхнього сайту.',
  qualified: 'Підходить. Далі — перевірка готовності до демо.',
};

/** Project states that mean a build is in flight right now. */
function isBusyProject(state: string | null | undefined): boolean {
  return ['pending', 'brief', 'building', 'qa'].includes(state ?? '');
}
