/**
 * Pins the five-word demo vocabulary (ui/lib/demoState.ts): every branch, the
 * precedence between them, and the BEAUTIFY Laser situation that motivated
 * it. Pure function, no database.
 *
 *   pnpm test:demo-state
 */
import { demoState, type DemoStateInput } from '../ui/lib/demoState.js';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`✅ ${label}`);
  else { failures++; console.error(`❌ ${label}`, detail ?? ''); }
}

const job = (jobType: string, status: string, extra: Partial<NonNullable<DemoStateInput['job']>> = {}) => ({
  jobType, status, errorDetail: null, runningForSec: null, resumesAt: null, ...extra,
});
const project = (state: string, extra: Partial<NonNullable<DemoStateInput['project']>> = {}) => ({
  state, deployUrl: null, qaIterations: null, openIssues: null, ...extra,
});

// nothing ever built
{
  const s = demoState({ status: 'production_ready', project: null, job: null });
  check('no project, no job → не будували', s.key === 'none' && s.text === 'не будували' && s.detail === null, s);
}

// BEAUTIFY Laser after «Зупинити»: cancelled project, cancelled job
{
  const s = demoState({ status: 'production_ready', project: project('cancelled'), job: job('build-site', 'cancelled') });
  check('stopped build → не будували, with the stop mentioned', s.key === 'none' && s.detail === 'попередню збірку зупинено', s);
}

// building: the live step wins over the project state
{
  const s = demoState({ status: 'site_in_progress', project: project('building'), job: job('build-site', 'running', { runningForSec: 14 * 60 }) });
  check('running build-site → будується · крок 2 з 4 · 14 хв',
    s.key === 'building' && s.detail === 'крок 2 з 4: збірка · 14 хв', s);
  const q = demoState({ status: 'production_ready', project: null, job: job('content-and-design', 'queued') });
  check('queued design step → будується · у черзі', q.key === 'building' && q.detail === 'крок 1 з 4: дизайн · у черзі', q);
  const p = demoState({ status: 'site_in_progress', project: project('qa'), job: job('visual-qa', 'retry_wait', { resumesAt: '14:30' }) });
  check('subscription pause → на паузі, with the resume time', p.key === 'building' && p.text === 'на паузі: ліміт підписки' && p.detail === 'відновиться о 14:30', p);
  const r = demoState({ status: 'site_in_progress', project: null, job: job('content-and-design', 'retry_wait', { errorCode: 'RUNNER_UNAVAILABLE', resumesAt: '09:12' }) });
  check('runner pause → на паузі: runner недоступний', r.key === 'building' && r.text === 'на паузі: runner недоступний' && r.detail === 'відновиться о 09:12', r);
}

// the critic asks
{
  const s = demoState({
    status: 'needs_review',
    project: project('needs_human_review', { qaIterations: 3, openIssues: ['a', 'b', 'c', 'd'] }),
    job: job('visual-qa', 'needs_human'),
  });
  check('critic park → критик не прийняв · 3 спроби · 4 зауваження',
    s.key === 'decision' && s.detail === '3 спроби · 4 зауваження' && s.tone === 'wait', s);
}

// failed: the BEAUTIFY case at 08:08 (pnpm ENOENT)
{
  const s = demoState({
    status: 'site_in_progress',
    project: project('failed'),
    job: job('build-site', 'failed', { errorDetail: 'Error: runner dependency install exited 254: [ENOENT] ENOENT: no such file or directory, mkdir\n    at x' }),
  });
  check('failed build step → впало with the step and a short reason',
    s.key === 'failed' && s.detail?.startsWith('збірка: runner dependency install exited 254') === true, s);
  const gate = demoState({ status: 'site_in_progress', project: null, job: job('content-and-design', 'needs_human', { errorDetail: 'Дизайн-гейт відхилив обидві спроби: wow floor' }) });
  check('design-gate park (no project) → впало: дизайн', gate.key === 'failed' && gate.detail?.startsWith('дизайн: Дизайн-гейт') === true, gate);
  const lost = demoState({ status: 'site_in_progress', project: project('building'), job: job('build-site', 'stale') });
  check('project in flight with no live step → впало (lost run)', lost.key === 'failed', lost);
}

// ready
{
  const s = demoState({ status: 'site_ready', project: project('deployed', { deployUrl: 'https://demo/x/' }), job: job('deploy-demo', 'succeeded') });
  check('deployed → готове', s.key === 'ready' && s.tone === 'go', s);
  const sent = demoState({ status: 'contacted', project: project('deployed', { deployUrl: 'https://demo/x/' }), job: job('deploy-demo', 'succeeded') });
  check('after the send the demo is still готове', sent.key === 'ready', sent);
}

// a skipped delivery is neither success nor failure: falls through to the project
{
  const s = demoState({ status: 'production_ready', project: project('cancelled'), job: job('build-site', 'skipped') });
  check('skipped step + cancelled project → не будували', s.key === 'none', s);
}

console.log(failures === 0 ? '\n🧭 DEMO STATE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
