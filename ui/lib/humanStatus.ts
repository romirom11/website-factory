/**
 * Machine status → what Roman actually reads.
 *
 * The console used to print raw enum values (`production_ready`,
 * `needs_human`, `retry_wait`) in coloured pills. That is a log, not an
 * interface: it asks the reader to hold the state machine in their head. Every
 * status here becomes ONE short phrase in the language of the business
 * ("Готово до демо"), plus a dot colour that says only whether the factory is
 * moving on its own, waiting for Roman, or stopped.
 *
 * The raw value is never thrown away — it stays available as a `title` tooltip
 * and in the history timeline, so debugging is still possible.
 */

export type DotTone = 'go' | 'wait' | 'stop' | 'idle';

export interface HumanStatus {
  /** The phrase shown to Roman. */
  text: string;
  tone: DotTone;
  /** True when this status is the factory waiting on a human decision. */
  needsRoman: boolean;
}

const BUSINESS: Record<string, HumanStatus> = {
  discovered: { text: 'Знайдено', tone: 'idle', needsRoman: false },
  prequalified: { text: 'Відібрано', tone: 'idle', needsRoman: false },
  enriching: { text: 'Збираємо дані', tone: 'go', needsRoman: false },
  needs_review: { text: 'Потрібна твоя увага', tone: 'wait', needsRoman: true },
  qualified: { text: 'Підходить', tone: 'go', needsRoman: false },
  production_ready: { text: 'Готово до демо', tone: 'go', needsRoman: false },
  site_in_progress: { text: 'Будуємо демо', tone: 'go', needsRoman: false },
  site_ready: { text: 'Демо готове — на підтвердження', tone: 'wait', needsRoman: true },
  outreach_approved: { text: 'Підтверджено', tone: 'go', needsRoman: false },
  contacted: { text: 'Написали', tone: 'go', needsRoman: false },
  replied: { text: 'Відповіли', tone: 'wait', needsRoman: true },
  meeting: { text: 'Зустріч', tone: 'go', needsRoman: false },
  proposal: { text: 'Пропозиція', tone: 'go', needsRoman: false },
  won: { text: 'Клієнт', tone: 'go', needsRoman: false },
  lost: { text: 'Не склалось', tone: 'stop', needsRoman: false },
  rejected: { text: 'Відхилено', tone: 'stop', needsRoman: false },
  duplicate: { text: 'Дублікат', tone: 'stop', needsRoman: false },
  closed: { text: 'Закрито', tone: 'stop', needsRoman: false },
  do_not_contact: { text: 'Не контактувати', tone: 'stop', needsRoman: false },
};

export function humanStatus(status: string): HumanStatus {
  return BUSINESS[status] ?? { text: status, tone: 'idle', needsRoman: false };
}

/**
 * WHAT a `needs_review` business is asking of Roman — the missing half of the
 * badge. «Потрібна твоя увага» covers three different requests, and every
 * surface (the inbox, the card header, the action band) must agree on which
 * one this is, so the classification lives here with the rest of the
 * status_reason semantics and nowhere else.
 *
 * - `fact_check`: the stage-8 critic refused the evidence package (or nobody
 *   independently checked it) — the ask is «прочитай факти і винеси вердикт».
 * - `materials`: the readiness gate found gaps — the ask is «дай матеріали
 *   або збудуй попри пропуски», and there can be many of these at once.
 * - `no_action`: the audit confidently found no opportunity (for example, the
 *   business already has a good modern site). That is history, not Roman's task.
 * - `verdict`: every other parked reason (contradiction, no evidence,
 *   fast-qualify doubts) — the ask is a yes/no about the business.
 */
export type ReviewAsk = 'fact_check' | 'materials' | 'no_action' | 'verdict';

export function reviewAsk(
  statusReason: string | null | undefined,
  websiteVerdict?: string | null,
): ReviewAsk {
  const r = (statusReason ?? '').trim();
  if (/^QA (failed|agent unavailable)/i.test(r)) return 'fact_check';
  if (/^gaps?:/i.test(r)) return 'materials';
  // The audit already proved the current site renders well. Failing to extract
  // its service list makes the evidence package sparse, but cannot turn a
  // no-op sales lead into a human decision or a reason to spend on a demo.
  if (websiteVerdict === 'working_good'
    && /owned website renders well but enrichment extracted zero services/i.test(r)) {
    return 'no_action';
  }
  const notQualified = /^not qualified:\s*(.+)$/i.exec(r);
  const reasons = notQualified
    ? notQualified[1]!.split(',').map((reason) => reason.trim().toLowerCase())
    : [r.toLowerCase()];
  if (reasons.includes('already_has_a_good_modern_site_no_opportunity')) {
    return 'no_action';
  }
  return 'verdict';
}

/**
 * Business status with the audit context needed to avoid a fake human task.
 *
 * The database keeps `needs_review` as the pipeline checkpoint, while the
 * owned-site audit can already prove that no demo is needed. On operator
 * surfaces that combination is a completed no-op, not «Потрібна твоя увага».
 */
export function humanBusinessStatus(input: {
  status: string;
  statusReason: string | null | undefined;
  websiteVerdict: string | null | undefined;
}): HumanStatus {
  if (input.status === 'needs_review'
    && reviewAsk(input.statusReason, input.websiteVerdict) === 'no_action') {
    return { text: 'Демо не потрібне', tone: 'idle', needsRoman: false };
  }
  return humanStatus(input.status);
}

/**
 * Reasons the pipeline writes for itself, translated for the person reading them.
 *
 * `status_reason` is written by workers in English and in their own vocabulary
 * ("QA limit (3) reached with 8 open issues"). It stays that way in the database
 * — it is an audit record — but printing it verbatim on the business card is the
 * console talking to itself in front of the owner.
 */
const REASON_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^QA limit \((\d+)\) reached with (\d+) open issues?$/i,
    (m) => `критик не прийняв збірку за ${m[1]} спроби, лишилось ${m[2]} зауважень`],
  [/^gaps?: (.+)$/i, (m) => {
    const items = m[1]!.split(',').map((g) => GAP_NAMES[g.trim()] ?? g.trim());
    return `бракує: ${items.join(', ')}`;
  }],
  [/^all gates passed \((.+)\)$/i, () => 'усі перевірки пройдено'],
  [/^not qualified: (.+)$/i, (m) => NOT_QUALIFIED[m[1]!.trim()] ?? `не підходить: ${m[1]}`],
  // The QA agent writes a paragraph of its own reasoning. Useful in the record,
  // unreadable in a header — the verdict is the half a person needs here.
  [/^QA failed:/i, () => 'перевірка фактів не пройдена — дивись «Факти й джерела»'],
  [/^contradiction: owned website renders well but enrichment extracted zero services from it$/i,
    () => 'сайт працює нормально; список послуг з нього не витягнувся'],
  [/^legacy-import:/i, () => 'перенесено зі старої бази'],
  // Everything below was still rendering as raw English on the card header,
  // the Історія tab or the settings page (sweep P1-10, P1-14).
  [/^score=([\d.]+)$/i, (m) => `бал ${m[1]}`],
  [/^detector fix: platform-owned contacts$/i,
    () => 'виправлено: контакти належать платформі, а не бізнесу'],
  [/^QA agent unavailable — package not independently verified$/i,
    () => 'перевіряльник був недоступний — пакет не звіряли незалежно'],
  [/^already_has_a_good_modern_site_no_opportunity$/i,
    () => 'у них уже є добрий сучасний сайт — пропонувати нічого'],
  [/^clean re-run of stages 4-8$/i, () => 'чистий перезапуск етапів 4–8'],
  [/^content-and-design could not run \(container was root.*$/i,
    () => 'збірка не запустилась: контейнер працював від root, Claude Code відмовився. '
      + 'Демосайт не створювався'],
  [/^no evidence available \(no gosom record, no page capturable\)$/i,
    () => 'немає доказів: ні запису gosom, ні сторінки, яку можна зняти'],
  [/^passed all fast checks$/i, () => 'пройшов усі швидкі перевірки'],
  [/^passed$/i, () => 'пройшов'],
  [/^site is actually working; wrong audit verdict$/i,
    () => 'сайт насправді працює — вердикт аудиту був хибний'],
  [/^stage 7 no longer hard-rejects; decision is reversible$/i,
    () => 'етап 7 більше не відхиляє остаточно — рішення оборотне'],
];

/**
 * The readiness gates, named by what is missing rather than by their key.
 *
 * Exported because three places need the SAME name for one gate: the status
 * line, the disabled build button's tooltip, and the «Чого бракує» list on the
 * Факти tab. When the tooltip said `assets_min3` while the header two lines
 * above said «бракує: фото (треба хоча б 3)» (sweep P1-12), the translation
 * already existed and was simply not applied.
 */
export const GAP_NAMES: Record<string, string> = {
  identity: 'опис бізнесу',
  services_min3: 'послуги (треба хоча б 3)',
  assets_min3: 'фото (треба хоча б 3)',
  hero_or_logo: 'головне фото або логотип',
  review_context: 'відгуки',
  socials_unresolved: 'соцмережі',
  contact_channel: 'спосіб звʼязку',
  verified_contact: 'підтверджений контакт',
};

/**
 * One gap key, in words.
 *
 * `production_gaps.gap` holds two different things: for HARD gaps it is one of
 * the keys above; for SOFT gaps the enrichment agent writes a whole English
 * sentence ("No email address found in either source."). A sentence is not a
 * key and must not be mangled by a lookup — it is returned unchanged, and the
 * caller decides whether an untranslated sentence belongs on the page at all.
 */
export function gapName(gap: string): string {
  const trimmed = gap.trim();
  return GAP_NAMES[trimmed] ?? trimmed;
}

/** True when `gap` is a known hard-gate key rather than free English prose. */
export function isGapKey(gap: string): boolean {
  return Object.prototype.hasOwnProperty.call(GAP_NAMES, gap.trim());
}

const NOT_QUALIFIED: Record<string, string> = {
  already_has_a_good_modern_site_no_opportunity: 'у них уже є добрий сучасний сайт — пропонувати нічого',
};

/**
 * A machine-written reason, in Roman's words.
 *
 * Everything the pipeline writes to `status_reason` is English, technical, and
 * occasionally not a sentence at all — one worker stores a bare demo URL there.
 * A raw URL printed as body text is the exact thing Roman objected to: it looks
 * clickable and is not. Anything left untranslated is at least kept out of the
 * header (see `humanReasonForHeader`).
 */
export function humanReason(reason: string): string {
  for (const [re, render] of REASON_PATTERNS) {
    const m = reason.match(re);
    if (m) return render(m);
  }
  return reason;
}

/**
 * The reason line for the card header — or nothing.
 *
 * Returns null when the stored reason is machine plumbing rather than a
 * sentence: a bare URL, or an untranslated snake_case token. Those still live in
 * the history tab, where a raw record is the point. Showing them at the top of
 * the card just puts unexplained English under the business's name.
 */
export function humanReasonForHeader(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (/^https?:\/\//i.test(trimmed)) return null;
  const human = humanReason(trimmed);
  // Still looks like a machine token (snake_case, no spaces, ASCII only)?
  if (human === trimmed && /^[a-z0-9_:.\-]+$/i.test(trimmed)) return null;
  return human;
}

/**
 * The status phrase plus its reason, when the reason adds something.
 *
 * `needs_review` alone says nothing actionable — "Потрібна твоя увага: 3
 * незакритих пропуски" does. Reasons written by the pipeline are technical, so
 * they are shortened rather than printed whole.
 */
export function humanStatusLine(status: string, reason?: string | null): string {
  const base = humanStatus(status).text;
  if (!reason) return base;
  const human = humanReason(reason);
  const short = human.length > 90 ? `${human.slice(0, 90)}…` : human;
  return `${base} · ${short}`;
}

const JOB: Record<string, HumanStatus> = {
  queued: { text: 'У черзі', tone: 'idle', needsRoman: false },
  running: { text: 'Виконується', tone: 'go', needsRoman: false },
  succeeded: { text: 'Готово', tone: 'go', needsRoman: false },
  failed: { text: 'Помилка', tone: 'stop', needsRoman: true },
  needs_human: { text: 'Потрібна твоя увага', tone: 'wait', needsRoman: true },
  cancelled: { text: 'Скасовано', tone: 'idle', needsRoman: false },
  // Written by the job reconciler (fix-funnel's P0-3 work): a job that was
  // `queued`/`running` when a worker died and can never finish, closed out so
  // the queue count stops counting ghosts. NOT a failure Roman caused and not
  // something he can retry into life — the honest word is that it was lost.
  // Without this entry the console printed the raw English `stale` for the 88
  // rows the reconciler closed.
  stale: { text: 'Втрачена (перезапуск)', tone: 'idle', needsRoman: false },
  // Not an error: the subscription window is exhausted and the queue resumes
  // by itself (SPEC §2.3b). Saying "failed" here would send Roman debugging
  // something that is working as designed.
  retry_wait: { text: 'Пауза: ліміт підписки', tone: 'wait', needsRoman: false },
};

export function humanJobStatus(status: string): HumanStatus {
  return JOB[status] ?? { text: status, tone: 'idle', needsRoman: false };
}

/**
 * Job-status line, with the resume time spelled out for a subscription pause.
 *
 * `resumesAt` is a PRE-FORMATTED string, not a Date, and that is the whole point:
 * formatting a time inside a component that renders on both sides produces the
 * server's timezone in the HTML and the browser's in the hydrated DOM. When they
 * differ React throws a hydration error (#418) and re-renders the subtree. The
 * caller formats once, on the server, and passes the result.
 */
export function humanJobLine(status: string, resumesAt?: string | null): string {
  const base = humanJobStatus(status).text;
  if (status !== 'retry_wait' || !resumesAt) return base;
  return `${base}, відновиться о ${resumesAt}`;
}

/**
 * Who did it — the `status_history.actor` column, in words.
 *
 * The actors are worker names (`readiness-gate`, `score-worker`,
 * `phaseB-reenrich`): correct in a log, meaningless in a timeline Roman reads
 * (sweep P1-10). `roman` is deliberately «ти» — the timeline is addressed to
 * him, and «Роман» in his own history reads like someone else did it.
 */
const ACTORS: Record<string, string> = {
  roman: 'ти',
  'readiness-gate': 'перевірка готовності',
  'score-worker': 'підрахунок балу',
  'enrich-worker': 'збір даних',
  'normalize-worker': 'нормалізація',
  'fast-qualify-worker': 'первинний відбір',
  'content-design-worker': 'збірка демо',
  'deploy-worker': 'публікація демо',
  'visual-qa': 'критик',
  'legacy-import': 'перенесення зі старої бази',
  'integration-repair': 'ремонт даних',
  'phaseB-reenrich': 'повторний збір даних',
  'phaseB-reset': 'скидання стану',
  'phaseB-unreject': 'повернення з відхилених',
};

export function humanActor(actor: string): string {
  return ACTORS[actor] ?? actor;
}

/** What the audit found about the business's CURRENT site, in plain words. */
const VERDICT: Record<string, { text: string; tone: DotTone }> = {
  no_website: { text: 'Свого сайту немає', tone: 'go' },
  broken: { text: 'Сайт зламаний', tone: 'go' },
  working_with_https_issue: { text: 'Сайт без захисту (http)', tone: 'wait' },
  outdated: { text: 'Сайт застарілий', tone: 'wait' },
  working_but_dated: { text: 'Сайт застарілий', tone: 'wait' },
  working_good: { text: 'Сайт уже добрий', tone: 'stop' },
  unreachable_all_endpoints: { text: 'Сайт не відкривається', tone: 'go' },
  none: { text: 'Свого сайту немає', tone: 'go' },
};

export function humanVerdict(verdict: string | null | undefined): { text: string; tone: DotTone } {
  if (!verdict) return { text: 'Сайт не перевіряли', tone: 'idle' };
  return VERDICT[verdict] ?? { text: verdict, tone: 'idle' };
}

/**
 * Contact channels, message states and reply events — the last raw enums.
 *
 * These rendered verbatim in the Контакти and Розмова tabs (sweep P2-9):
 * `whatsapp`, `manual_pending`, `simulated`. Lowercase machine tokens next to
 * Ukrainian labels read as an unfinished page.
 */
const CHANNELS: Record<string, string> = {
  phone: 'Телефон',
  email: 'Пошта',
  website: 'Сайт',
  contact_form: 'Форма звʼязку',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  viber: 'Viber',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

export function humanChannel(channel: string): string {
  return CHANNELS[channel] ?? channel;
}

const MESSAGE_STATES: Record<string, string> = {
  draft: 'чернетка',
  manual_pending: 'чекає ручної відправки',
  simulated: 'симуляція (тестовий режим)',
  queued: 'у черзі',
  sent: 'надіслано',
  delivered: 'доставлено',
  read: 'прочитано',
  failed: 'не вдалося надіслати',
  delivery_unknown: 'результат відправки невідомий — не повторювати',
};

export function humanMessageState(state: string): string {
  return MESSAGE_STATES[state] ?? state;
}

const OUTREACH_EVENTS: Record<string, string> = {
  replied: 'відповіли',
  opted_out: 'попросили не писати',
  bounced: 'лист не дійшов',
  opened: 'відкрили',
  clicked: 'перейшли за посиланням',
  sent: 'надіслано',
  delivered: 'доставлено',
  failed: 'відправка не вдалася',
  delivery_unknown: 'результат відправки невідомий',
};

export function humanOutreachEvent(event: string): string {
  return OUTREACH_EVENTS[event] ?? event;
}

/** State of a demo build, in Roman's words. */
const PROJECT: Record<string, HumanStatus> = {
  pending: { text: 'Збірка в черзі', tone: 'idle', needsRoman: false },
  brief: { text: 'Готуємо дизайн', tone: 'go', needsRoman: false },
  building: { text: 'Будуємо', tone: 'go', needsRoman: false },
  qa: { text: 'Перевіряємо', tone: 'go', needsRoman: false },
  ready: { text: 'Зібрано', tone: 'go', needsRoman: false },
  deployed: { text: 'Демо опубліковано', tone: 'go', needsRoman: false },
  needs_human_review: { text: 'Критик не прийняв — виріши сам', tone: 'wait', needsRoman: true },
  failed: { text: 'Збірка впала', tone: 'stop', needsRoman: true },
  // A cancelled build is a real state the pipeline writes (one such row exists);
  // without it the console printed the raw English word (sweep P2-7).
  cancelled: { text: 'Збірку скасовано', tone: 'idle', needsRoman: false },
};

export function humanProjectState(state: string | null | undefined): HumanStatus {
  if (!state) return { text: 'Демо ще не будували', tone: 'idle', needsRoman: false };
  return PROJECT[state] ?? { text: state, tone: 'idle', needsRoman: false };
}
