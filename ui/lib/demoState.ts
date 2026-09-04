/**
 * The ONE answer to «а що з демо?» for a business.
 *
 * The database keeps three truths about a build — the business status, the
 * site project state and the newest build-chain job — and every screen used
 * to pick a different one to show. Roman read «Готово до демо» on the header,
 * «Збірка впала» on the Демо tab and «Готово» on the job row for the same
 * business at the same moment (BEAUTIFY Laser, 2026-09-03), and could not
 * tell whether a demo existed.
 *
 * This module folds the three into five words a person can act on:
 *
 *   none      — nothing built (yet, or any more): the next thing is «Побудувати демо»
 *   building  — the factory is working; nothing to press, something to watch
 *   decision  — the factory stopped on purpose and is asking Roman (the critic)
 *   failed    — the last attempt died; the next thing is «Побудувати заново»
 *   ready     — a demo exists at a URL
 *
 * Pure and import-free beyond the tone type, so the business card, the list
 * and the Вхідні render the same sentence from the same inputs, and a unit
 * test can pin every branch without a database. The action to offer stays in
 * `cardActions.ts`; this is the state that action reads.
 */
import type { DotTone } from './humanStatus';

export type DemoStateKey = 'none' | 'building' | 'decision' | 'failed' | 'ready';

export interface DemoState {
  key: DemoStateKey;
  /** «Демо: …» — the sentence, without the «Демо:» prefix. */
  text: string;
  /** Second clause with the specifics (step, attempts, reason), when any. */
  detail: string | null;
  tone: DotTone;
}

export interface DemoStateInput {
  status: string;
  project: {
    state: string;
    deployUrl: string | null;
    qaIterations: number | null;
    openIssues: string[] | null;
  } | null;
  /** Newest build-chain job (content-and-design / build-site / visual-qa / deploy-demo). */
  job: {
    jobType: string;
    status: string;
    /** `RATE_LIMITED` vs `RUNNER_UNAVAILABLE` tells the two pauses apart. */
    errorCode?: string | null;
    errorDetail: string | null;
    /** Seconds since the running attempt started; null when unknown. */
    runningForSec: number | null;
    /** Pre-formatted resume time for a subscription pause. */
    resumesAt: string | null;
  } | null;
}

const BUILD_STEPS = ['content-and-design', 'build-site', 'visual-qa', 'deploy-demo'] as const;
const STEP_TITLES: Record<string, string> = {
  'content-and-design': 'дизайн',
  'build-site': 'збірка',
  'visual-qa': 'перевірка',
  'deploy-demo': 'публікація',
};
const ACTIVE_JOB = new Set(['queued', 'running', 'retry_wait']);
const IN_FLIGHT_PROJECT = new Set(['pending', 'brief', 'building', 'qa', 'ready']);

function minutes(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'щойно почалась';
  if (min < 60) return `${min} хв`;
  return `${Math.floor(min / 60)} год ${min % 60} хв`;
}

/** First sentence of a worker's error, trimmed for a header line. */
function shortReason(detail: string | null): string | null {
  if (!detail) return null;
  const first = detail.split('\n').find((line) => line.trim())?.trim() ?? '';
  const cleaned = first.replace(/^Error:\s*/i, '').replace(/^\[[A-Z_]+\]\s*/, '');
  if (!cleaned) return null;
  return cleaned.length > 90 ? `${cleaned.slice(0, 90)}…` : cleaned;
}

export function demoState(input: DemoStateInput): DemoState {
  const { status, project, job } = input;
  const buildJob = job && (BUILD_STEPS as readonly string[]).includes(job.jobType) ? job : null;

  // The critic parked it: the factory is asking, not failing.
  if (project?.state === 'needs_human_review') {
    const attempts = project.qaIterations ?? 0;
    const issues = project.openIssues?.length ?? 0;
    return {
      key: 'decision',
      text: 'критик не прийняв',
      detail: [attempts ? `${attempts} ${plural(attempts, 'спроба', 'спроби', 'спроб')}` : null,
        issues ? `${issues} ${plural(issues, 'зауваження', 'зауваження', 'зауважень')}` : null]
        .filter(Boolean).join(' · ') || null,
      tone: 'wait',
    };
  }

  // A live step wins over any project state: it is what is happening now.
  if (buildJob && ACTIVE_JOB.has(buildJob.status)) {
    const stepIndex = (BUILD_STEPS as readonly string[]).indexOf(buildJob.jobType) + 1;
    if (buildJob.status === 'retry_wait') {
      return {
        key: 'building',
        text: buildJob.errorCode === 'RUNNER_UNAVAILABLE' ? 'на паузі: runner недоступний' : 'на паузі: ліміт підписки',
        detail: buildJob.resumesAt ? `відновиться о ${buildJob.resumesAt}` : 'відновиться сама',
        tone: 'wait',
      };
    }
    const when = buildJob.status === 'queued' ? 'у черзі' : minutes(buildJob.runningForSec);
    return {
      key: 'building',
      text: 'будується',
      detail: [`крок ${stepIndex} з ${BUILD_STEPS.length}: ${STEP_TITLES[buildJob.jobType]}`, when]
        .filter(Boolean).join(' · '),
      tone: 'go',
    };
  }

  // Deployed and beyond: the demo exists.
  if (project?.state === 'deployed' && project.deployUrl) {
    return { key: 'ready', text: 'готове', detail: null, tone: 'go' };
  }
  if (project?.deployUrl && !['failed', 'cancelled'].includes(project.state)) {
    return { key: 'ready', text: 'готове', detail: null, tone: 'go' };
  }

  // The newest step died and nothing replaced it.
  if (buildJob && (buildJob.status === 'failed' || buildJob.status === 'needs_human')) {
    return {
      key: 'failed',
      text: 'впало',
      detail: [STEP_TITLES[buildJob.jobType], shortReason(buildJob.errorDetail)].filter(Boolean).join(': ') || null,
      tone: 'stop',
    };
  }
  if (project && (project.state === 'failed')) {
    return { key: 'failed', text: 'впало', detail: 'збірку перервано', tone: 'stop' };
  }

  // A project says in-flight but no job is alive: the run was lost somewhere.
  if (project && IN_FLIGHT_PROJECT.has(project.state) && status === 'site_in_progress') {
    return {
      key: 'failed',
      text: 'впало',
      detail: 'збірка обірвалась без кроку, що йде',
      tone: 'stop',
    };
  }

  if (project?.state === 'cancelled') {
    return { key: 'none', text: 'не будували', detail: 'попередню збірку зупинено', tone: 'idle' };
  }
  return { key: 'none', text: 'не будували', detail: null, tone: 'idle' };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
