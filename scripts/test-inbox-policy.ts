/**
 * Pure regression checks for what belongs in Roman's inbox.
 *
 * A confident machine verdict is useful history, not automatically a human
 * task. Only states where the factory genuinely needs a decision may produce
 * an inbox card.
 */
import { buildButtonState } from '../ui/lib/buildPolicy.js';
import { cardActionBar } from '../ui/lib/cardActions.js';
import { filtersToQuery, parseFilters } from '../ui/lib/businessQuery.js';
import { humanBusinessStatus, humanReasonForHeader, reviewAsk } from '../ui/lib/humanStatus.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`✅ ${label}`);
  else { failures++; console.error(`❌ ${label}`, detail ?? ''); }
}

check(
  'a good existing site is a completed no-action verdict, not an inbox task',
  reviewAsk('not qualified: already_has_a_good_modern_site_no_opportunity') === 'no_action',
  reviewAsk('not qualified: already_has_a_good_modern_site_no_opportunity'),
);
check(
  'a good-site verdict stays no-action when the scorer records another reason too',
  reviewAsk(
    'not qualified: already_has_a_good_modern_site_no_opportunity,no_reachable_contact_channel',
  ) === 'no_action',
);
check('failed fact QA still needs a decision', reviewAsk('QA failed: unsupported claim') === 'fact_check');
check('material gaps stay out of individual decision cards', reviewAsk('gaps: hero_or_logo') === 'materials');
check('an ambiguous qualifier verdict still needs a decision', reviewAsk('contradiction: phone mismatch') === 'verdict');

// The audit verdict is the stronger fact for this precise contradiction: the
// current site rendered well, so missing extracted services may make the
// evidence package sparse, but it does not create a sales opportunity or a
// decision for Roman.
check(
  'working-good + zero extracted services is a completed no-action verdict',
  reviewAsk(
    'contradiction: owned website renders well but enrichment extracted zero services from it',
    'working_good',
  ) === 'no_action',
);
const goodSiteStatus = humanBusinessStatus({
  status: 'needs_review',
  statusReason: 'contradiction: owned website renders well but enrichment extracted zero services from it',
  websiteVerdict: 'working_good',
});
check(
  'a completed good-site verdict is not labelled as needing attention',
  goodSiteStatus.text === 'Демо не потрібне' && !goodSiteStatus.needsRoman,
  goodSiteStatus,
);
check(
  'the good-site contradiction is translated for the business card',
  humanReasonForHeader(
    'contradiction: owned website renders well but enrichment extracted zero services from it',
  ) === 'сайт працює нормально; список послуг з нього не витягнувся',
);
const attentionFilter = parseFilters({ attention: '1' });
check(
  'the semantic attention preset survives URL parsing and serialization',
  attentionFilter.attention
    && filtersToQuery({ attention: true }).includes('attention=1'),
  attentionFilter,
);

const failedFactReview = cardActionBar({
  businessId: 'fixture-fact-review',
  status: 'needs_review',
  projectState: null,
  projectId: null,
  deployUrl: null,
  build: {
    enabled: true,
    needsConfirm: true,
    availability: 'eligible',
    hint: 'Пропусків немає',
  },
  socials: { enabled: true, hint: 'Дошукати соцмережі' },
  openGaps: [],
  socialsGap: false,
  hasPendingApproval: false,
  statusReason: 'QA failed: unsupported service claim',
});
check(
  'failed fact review offers every way to finish the decision',
  failedFactReview.actions.map((action) => action.label).join('|')
    === 'Факти правильні — будувати|Перезібрати факти|Не брати в роботу',
  failedFactReview.actions.map((action) => action.label),
);

const goodSiteBuild = buildButtonState({
  status: 'needs_review',
  openGaps: [],
  activeProjectState: null,
  activeJobStatus: null,
  statusReason: 'contradiction: owned website renders well but enrichment extracted zero services from it',
  verdict: 'working_good',
  hasEvidence: true,
});
check(
  'working-good stays a no-demo verdict on the business card too',
  goodSiteBuild.availability === 'disqualified'
    && goodSiteBuild.disqualifiedText === 'У бізнесу вже нормальний сайт — демо не потрібне',
  goodSiteBuild,
);

const pausedBuild = buildButtonState({
  status: 'production_ready',
  openGaps: [],
  activeProjectState: 'failed',
  activeJobStatus: 'retry_wait',
  hasEvidence: true,
});
check(
  'retry_wait says the build is paused by the subscription limit, not merely queued',
  pausedBuild.availability === 'busy'
    && pausedBuild.hint === 'Збірка на паузі через ліміт підписки',
  pausedBuild,
);

const recoveringBuild = cardActionBar({
  businessId: 'fixture-business',
  status: 'production_ready',
  projectState: 'failed',
  projectId: 1,
  deployUrl: null,
  build: {
    enabled: false,
    needsConfirm: false,
    availability: 'busy',
    hint: 'Збірка вже стоїть у черзі',
  },
  socials: { enabled: true, hint: 'Дошукати соцмережі' },
  openGaps: [],
  socialsGap: false,
  hasPendingApproval: false,
  statusReason: null,
});
check(
  'a failed old project with an active replacement asks for no human action',
  recoveringBuild.actions.length === 0 && Boolean(recoveringBuild.waiting),
  recoveringBuild,
);

// A project stuck in `qa` whose newest step skipped itself: nothing will ever
// move it, and the policy still calls the project «busy» (BEAUTIFY, 2026-09-05).
const stalledInput = {
  businessId: 'fixture-stalled',
  status: 'site_in_progress',
  projectState: 'qa',
  projectId: 5,
  deployUrl: null,
  build: {
    enabled: false,
    needsConfirm: false,
    availability: 'busy' as const,
    hint: 'Демо для цього бізнесу вже будується',
  },
  socials: { enabled: true, hint: 'Дошукати соцмережі' },
  openGaps: [],
  socialsGap: false,
  hasPendingApproval: false,
  statusReason: null,
};
const stalled = cardActionBar({ ...stalledInput, buildJobStatus: 'skipped' });
check(
  'a project stuck in qa with no live step offers resume first, rebuild second',
  stalled.waiting === null
    && stalled.actions.map((a) => a.label).join(',') === 'Продовжити збірку,Побудувати заново'
    && (stalled.actions[0] as { mode?: string }).mode === 'resume'
    && (stalled.actions[1] as { mode?: string }).mode === 'fresh'
    && (stalled.hint ?? '').includes('перевірка критиком'),
  stalled,
);
const moving = cardActionBar({ ...stalledInput, buildJobStatus: 'running' });
check(
  'the same project with a running step is just waiting',
  moving.actions.length === 0 && Boolean(moving.waiting),
  moving,
);
// A published demo is still editable: the send stays, and a fix form joins it.
const published = cardActionBar({
  ...stalledInput,
  status: 'site_ready',
  projectState: 'deployed',
  projectId: 6,
  deployUrl: 'https://demo/x/',
  build: { enabled: false, needsConfirm: false, availability: 'busy' as const, hint: 'Демо для цього бізнесу вже будується' },
  buildJobStatus: 'succeeded',
});
check(
  'a published demo keeps its send and open buttons and offers a fix',
  published.fix?.projectId === 6
    && published.actions.map((a) => a.label).join(',') === 'Підтвердити відправку,Відкрити демо',
  published,
);
const noProject = cardActionBar({ ...stalledInput, projectState: null, projectId: null, buildJobStatus: 'failed' });
check(
  'a dead design step with no project offers only a fresh rebuild',
  noProject.actions.length === 1 && (noProject.actions[0] as { mode?: string }).mode === 'fresh',
  noProject,
);

console.log(failures === 0 ? '\n🧪 INBOX POLICY TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
