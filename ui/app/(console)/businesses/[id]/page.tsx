import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { Status } from '@/components/Status';
import { Tabs, type TabDef } from '@/components/Tabs';
import { CardActionBar } from '@/components/CardActionBar';
import { OtherActionsDialog } from '@/components/OtherActionsDialog';
import { BuildReviewCard } from '@/components/BuildReviewCard';
import { DealStageForm } from '@/components/DealStageForm';
import { BUSINESS_STATUSES, fmtDate, fmtTime, truncate, safeHttpUrl, linkLabel } from '@/lib/format';
import {
  humanBusinessStatus, humanStatus, humanProjectState, humanReasonForHeader, humanVerdict,
  humanActor, humanReason, gapName,
  humanChannel, humanMessageState, humanOutreachEvent,
} from '@/lib/humanStatus';
import { parseCriticNotes, softGapText, isSoftGapTranslated } from '@/lib/criticNotes';
import { parseAuditNotes } from '@/lib/auditNotes';
import { FactValue } from '@/components/FactValue';
import { factLabel, groupFacts } from '@/lib/factLabels';
import { buildButtonState } from '@/lib/buildPolicy';
import { demoState } from '@/lib/demoState';
import { cardActionBar, isFactCheckAttention } from '@/lib/cardActions';
import { FindSocialsButton } from '@/components/FindSocialsButton';
import { HeroVideoPanel } from '@/components/HeroVideoPanel';
import { readRawJson } from '@/lib/objectStore';
import { SocialsPanel, type SocialContactRow } from '@/components/SocialsPanel';
import { isSocialChannel, socialsButtonState } from '@/lib/socials';
import { BrandSwatches } from '@/components/BrandSwatches';
import { RefreshBrandButton } from '@/components/RefreshBrandButton';
import { LiveBuildPanel } from '@/components/LiveBuildPanel';

export const dynamic = 'force-dynamic';

/** The six wow axes, in words rather than camelCase keys. */
const WOW_AXIS_LABELS: Record<string, string> = {
  heroMotion: 'рух на першому екрані',
  scrollChoreography: 'рух при скролі',
  typeAsDesign: 'типографіка',
  photoTreatment: 'фото',
  microInteraction: 'дрібні деталі',
  performanceReducedMotion: 'швидкість і доступність',
};

/** Which viewport / moment a QA screenshot came from, out of its object key. */
function shotLabel(key: string): string {
  const base = key.split('/').pop() ?? key;
  if (base.includes('desktop-reduced-motion')) return 'без анімацій';
  if (base.includes('desktop')) return 'комп’ютер';
  if (base.includes('tablet')) return 'планшет';
  if (base.includes('mobile')) return 'телефон';
  const load = /motion-load-t([\d.]+)s/.exec(base);
  if (load) return `рух, ${load[1]}с після відкриття`;
  const scroll = /motion-scroll-(\d+)pct/.exec(base);
  if (scroll) return `скрол ${Number(scroll[1])}%`;
  return base;
}

/**
 * A `status_history.reason`, for the timeline.
 *
 * That column is one free-text field mixing machine codes (`gaps: assets_min3`),
 * English QA paragraphs, Ukrainian human notes, and — in one row — a bare deploy
 * URL (sweep P1-10). `humanReason` handles the known patterns; the two shapes it
 * cannot are handled here, because a URL printed as body text looks clickable
 * and is not, and an 1,800-character English paragraph in a timeline row is a
 * wall rather than a record.
 */
function historyReason(reason: string): string {
  const trimmed = reason.trim();
  if (/^https?:\/\//i.test(trimmed)) return 'демо опубліковано';
  const human = humanReason(trimmed);
  return human.length > 160 ? `${human.slice(0, 160)}…` : human;
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      {title && <h3 className="label">{title}</h3>}
      {children}
    </section>
  );
}

export default async function BusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, id));
  if (!biz) notFound();

  const [facts, contacts, sources, assetRows, audits, gaps, projects, history, messages, quals, dealRows, events] =
    await Promise.all([
      db.select().from(schema.businessFacts).where(eq(schema.businessFacts.businessId, id)),
      db.select().from(schema.businessContacts).where(eq(schema.businessContacts.businessId, id)),
      db.select().from(schema.businessSources).where(eq(schema.businessSources.businessId, id)),
      db.select().from(schema.assets).where(eq(schema.assets.businessId, id)),
      db.select().from(schema.websiteAudits).where(eq(schema.websiteAudits.businessId, id))
        .orderBy(desc(schema.websiteAudits.auditedAt)),
      db.select().from(schema.productionGaps).where(eq(schema.productionGaps.businessId, id)),
      db.select().from(schema.siteProjects).where(eq(schema.siteProjects.businessId, id))
        .orderBy(desc(schema.siteProjects.createdAt)),
      db.select().from(schema.statusHistory).where(eq(schema.statusHistory.businessId, id))
        .orderBy(desc(schema.statusHistory.at)),
      db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.businessId, id))
        .orderBy(asc(schema.outreachMessages.id)),
      db.select().from(schema.qualifications).where(eq(schema.qualifications.businessId, id))
        .orderBy(desc(schema.qualifications.at)),
      db.select().from(schema.deals).where(eq(schema.deals.businessId, id)),
      db.select().from(schema.outreachEvents).where(eq(schema.outreachEvents.businessId, id))
        .orderBy(asc(schema.outreachEvents.at)),
    ]);

  const [buildJob] = await db.select().from(schema.workflowJobs)
    .where(and(
      eq(schema.workflowJobs.businessId, id),
      inArray(schema.workflowJobs.jobType, ['content-and-design', 'build-site', 'visual-qa', 'deploy-demo']),
    ))
    .orderBy(desc(schema.workflowJobs.createdAt)).limit(1);

  const [socialsJob] = await db.select().from(schema.workflowJobs)
    .where(and(
      eq(schema.workflowJobs.businessId, id),
      eq(schema.workflowJobs.jobType, 'enrich-socials'),
    ))
    .orderBy(desc(schema.workflowJobs.createdAt)).limit(1);

  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const audit = audits[0];
  const project = projects[0];
  const deal = dealRows[0];
  const wow = project?.wowScores ?? null;
  const unresolvedGaps = gaps.filter((g) => !g.resolved);
  // Hard gaps are gate KEYS (`assets_min3`); soft gaps are whole sentences the
  // enrichment agent writes in the language of the evidence, with a Ukrainian
  // rendering stored alongside in `gapUk`. Two vocabularies, two panels —
  // mixing them is what produced the English wall on this tab (sweep P0-6).
  const hardGaps = unresolvedGaps.filter((g) => g.blockerLevel === 'hard');
  const softGaps = unresolvedGaps.filter((g) => g.blockerLevel !== 'hard');
  const openGaps = hardGaps.map((g) => g.gap);
  // The critic writes English; `score.ts` stores a Ukrainian rendering next to
  // it at write time. Ukrainian leads, English is the fallback for rows written
  // before that and for a translation call that failed.
  const criticNotes = parseCriticNotes(quals[0]?.qaNotesUk ?? quals[0]?.qaNotes);
  const criticNotesOriginal = quals[0]?.qaNotesUk ? parseCriticNotes(quals[0]?.qaNotes) : null;
  const auditNotes = parseAuditNotes(audit?.notes);
  const verdict = humanVerdict(audit?.verdict);
  const status = humanBusinessStatus({
    status: biz.status,
    statusReason: biz.statusReason,
    websiteVerdict: audit?.verdict,
  });
  const headerReason = humanReasonForHeader(biz.statusReason);

  const matchByUrl = new Map<string, Record<string, unknown>>();
  for (const f of facts) {
    if (!f.key.startsWith('social_match.')) continue;
    const v = f.value as Record<string, unknown> | null;
    if (v && typeof v.url === 'string') matchByUrl.set(v.url.toLowerCase(), v);
  }
  const socialContacts: SocialContactRow[] = contacts
    .filter((c) => isSocialChannel(c.channel))
    .map((c) => {
      const m = matchByUrl.get(c.value.toLowerCase()) ?? null;
      return {
        id: c.id,
        channel: c.channel,
        value: c.value,
        verified: c.verified,
        verifiedBy: c.verifiedBy,
        sourceUrl: (c.sourceId ? sourceById.get(c.sourceId)?.url : null) ?? null,
        match: m
          ? {
            strength: typeof m.strength === 'string' ? m.strength : undefined,
            score: typeof m.score === 'number' ? m.score : undefined,
            signals: Array.isArray(m.signals) ? (m.signals as string[]) : undefined,
            blockers: Array.isArray(m.blockers) ? (m.blockers as string[]) : undefined,
          }
          : null,
      };
    });

  const socialsState = socialsButtonState({
    verifiedPlatforms: contacts.filter((c) => c.verified).map((c) => c.channel),
    activeJobStatus: socialsJob?.status,
    status: biz.status,
  });
  const buildState = buildButtonState({
    status: biz.status,
    openGaps,
    activeProjectState: project?.state,
    activeJobStatus: buildJob?.status,
    statusReason: biz.statusReason,
    verdict: audit?.verdict,
    // Facts or contacts are what "the pipeline looked at this" means. A card
    // with neither has no gaps because nobody searched for any (sweep P1-2).
    hasEvidence: facts.length > 0 || contacts.length > 0,
  });

  // Is this business sitting in Вхідні waiting for a send decision? If so the
  // card's primary action is "go decide it there", not a second approve form —
  // approving needs the channel and the message text, which live on that card.
  const [pendingApproval] = await db.select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.businessId, id),
      eq(schema.approvals.kind, 'outreach'),
      isNull(schema.approvals.decision),
    ))
    .limit(1);

  // The one sentence about the demo — the five-word vocabulary every surface
  // shares (ui/lib/demoState.ts). Rendered in the header above the action band.
  const demo = demoState({
    status: biz.status,
    project: project
      ? {
        state: project.state,
        deployUrl: project.deployUrl,
        qaIterations: project.qaIterations,
        openIssues: (project.openIssues as string[] | null) ?? null,
      }
      : null,
    job: buildJob
      ? {
        jobType: buildJob.jobType,
        status: buildJob.status,
        errorDetail: buildJob.errorDetail,
        runningForSec: buildJob.status === 'running' && buildJob.startedAt
          ? Math.max(0, Math.round((Date.now() - buildJob.startedAt.getTime()) / 1000))
          : null,
        resumesAt: buildJob.status === 'retry_wait' && buildJob.nextAttemptAt
          ? fmtTime(buildJob.nextAttemptAt)
          : null,
      }
      : null,
  });

  // The one place that decides what can be done with this business right now.
  const actionBar = cardActionBar({
    businessId: biz.id,
    status: biz.status,
    projectState: project?.state,
    projectId: project?.id,
    deployUrl: project?.deployUrl,
    build: buildState,
    socials: socialsState,
    openGaps,
    socialsGap: gaps.some((g) => !g.resolved && g.gap === 'socials_unresolved'),
    hasPendingApproval: Boolean(pendingApproval),
    statusReason: biz.statusReason,
  });

  // «Потрібна твоя увага» через фактчек означає «прочитай звіт критика», тож
  // картка відкривається одразу на тій вкладці, з розгорнутим звітом — а не на
  // «Демо», де про причину уваги нема ні слова (Роман, 2026-08-23).
  const factCheckAttention = isFactCheckAttention(biz.status, biz.statusReason);

  // ── Демо ──────────────────────────────────────────────────────────────────
  // States in which a build is (or should be) moving. A build takes an hour, so
  // for exactly these states the tab leads with the live trace instead of a
  // one-word status — see LiveBuildPanel for why that word was not enough.
  const IN_FLIGHT_STATES = new Set(['pending', 'brief', 'building', 'qa']);

  const latestHeroClip = [...assetRows]
    .filter((a) => a.intendedUsage === 'hero_clip')
    .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime())
    .at(-1) ?? null;
  // The wow-video brief is AUTHORED BY THE ART DIRECTOR inside the design
  // contract (Roman, 2026-08-22: «Звідки воно знає, яке відео треба для
  // дизайну?» — про generic-промпт, якого більше немає). No contract yet, or a
  // pre-v2 contract → no brief; the panel says it arrives with the first build.
  const contractDoc = project?.designContractKey
    ? await readRawJson<{ schemaVersion?: number; chosen?: { heroVideoBrief?: string | null; heroVideoStartFrame?: string | null } }>(project.designContractKey)
    : null;
  const heroVideoBrief = (contractDoc?.schemaVersion ?? 1) >= 2 && contractDoc?.chosen?.heroVideoBrief
    ? contractDoc.chosen.heroVideoBrief
    : null;
  // The start frame is THE FILE THE BRIEF NAMES — never a guess. The first
  // version guessed «the hero asset» and offered a vertical text banner while
  // the brief described a different photo entirely.
  const startFrameName = contractDoc?.chosen?.heroVideoStartFrame?.split('/').pop() ?? null;
  const startFrameRow = startFrameName
    ? assetRows.find((a) => (a.objectKey.split('/').pop() ?? '') === startFrameName)
    : null;
  // The live panel covers the WHOLE run, including the pre-project design
  // stage: it renders whenever a build-chain job is alive OR the newest
  // project is in flight. The pipeline log is business-keyed, so one panel
  // follows the run from «Дизайн-етап почався» to deploy without switching.
  const buildChainActive = buildJob
    && ['queued', 'running', 'retry_wait'].includes(buildJob.status);
  // «Побудувати заново» starts with the design step, and the new project row
  // only appears when that step hands off to the builder. Until then the
  // newest project is the DEAD one, and showing its «Збірка впала» under a
  // live log reads as a contradiction (BEAUTIFY Laser, 2026-09-04). While a
  // step is alive, a failed/cancelled project is history, not the state.
  const staleProject = Boolean(project && buildChainActive
    && ['failed', 'cancelled'].includes(project.state));
  const demoTab = (
    <div className="space-y-4">
      {(buildChainActive || (project && IN_FLIGHT_STATES.has(project.state))) && (
        <LiveBuildPanel businessId={biz.id} projectState={staleProject ? null : project?.state ?? null} />
      )}

      {/* A build the critic rejected gets the full decision card right here —
          the SAME component the inbox renders, so the three actions have one
          implementation and one behaviour to keep working. */}
      {project?.state === 'needs_human_review' && (
        <div id="build-review" className="scroll-mt-4">
        {/* Evidence only: the preview, the score, what the critic said. The
            three decisions are in the header band, where they are reachable
            without scrolling past all of this. */}
        <BuildReviewCard
          showName={false}
          showDecision={false}
          item={{
            projectId: project.id,
            businessId: biz.id,
            name: biz.name,
            campaignId: biz.campaignId,
            score: biz.score,
            qaIterations: project.qaIterations,
            openIssues: (project.openIssues as string[] | null) ?? [],
            designDirection: project.designDirection,
            wowTotal: wow?.qa?.total ?? null,
            wowPassed: wow?.qa?.passed ?? null,
            screenshotKeys: (project.screenshotKeys as string[] | null) ?? [],
            qaReportKeys: (project.qaReportKeys as string[] | null) ?? [],
            updatedAt: biz.updatedAt,
          }}
        />
        </div>
      )}

      {/* No build strip here: «Побудувати демо» lives in the header, where it is
          visible without scrolling. This tab only ever shows demo THINGS. */}
      {!project && !buildChainActive && (
        <Panel>
          <p className="text-sm text-ink-soft">
            Демосайт для цього бізнесу ще не будували. Кнопка — угорі картки.
          </p>
        </Panel>
      )}

      {project && project.state !== 'needs_human_review' && !staleProject && (
        <Panel>
          {/* No «Відкрити демо» link here: it is in the header band. This panel
              shows the demo itself, which is what the tab is for. */}
          <Status tone={humanProjectState(project.state).tone} title={project.state}>
            {humanProjectState(project.state).text}
          </Status>
          {project.state === 'deployed' && biz.status === 'site_ready' && (
            <p className="text-sm text-ink-soft mt-2">
              Далі — підтвердити відправку: лист і канал чекають у{' '}
              <Link href={`/inbox?business=${encodeURIComponent(biz.id)}`} className="link">Вхідних</Link>.
            </p>
          )}
          {project.state === 'deployed' && project.deployUrl && (
            <div className="mt-4 rounded-xl border border-line overflow-hidden bg-white">
              <iframe
                src={project.deployUrl}
                title={`Демо ${biz.name}`}
                sandbox="allow-scripts allow-same-origin"
                className="w-full bg-white block"
                style={{ height: 420, border: 0 }}
              />
            </div>
          )}
        </Panel>
      )}

      {/* What the art direction promised vs what the built page delivered. */}
      {wow && (wow.qa || wow.design) && (
        <Panel title="Оцінка дизайну">
          <p className="text-sm text-ink-soft">
            {(wow.qa ?? wow.design)!.total} з 18
            {(wow.qa ?? wow.design)!.ambition !== undefined
              && ` · амбіція ${(wow.qa ?? wow.design)!.ambition} з 15`}
            {wow.design && wow.qa && ` · планували ${wow.design.total}, вийшло ${wow.qa.total}`}
          </p>
          <ul className="grid sm:grid-cols-2 gap-x-8 mt-3">
            {Object.entries((wow.qa ?? wow.design)!.axes).map(([axis, value]) => (
              <li key={axis} className="flex justify-between text-sm border-b border-line py-1.5">
                <span className="text-ink-soft">{WOW_AXIS_LABELS[axis] ?? axis}</span>
                <span className={`tabular-nums ${value <= 1 ? 'text-dot-wait' : 'text-ink'}`}>
                  {value} / 3
                </span>
              </li>
            ))}
          </ul>
          {(wow.qa ?? wow.design)!.reasons.map((r, i) => (
            <p key={i} className="text-sm text-dot-wait mt-2">{r}</p>
          ))}
        </Panel>
      )}

      {project?.screenshotKeys && (project.screenshotKeys as string[]).length > 0 && (
        <Panel title="Як сторінка виглядала при перевірці">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {(project.screenshotKeys as string[]).slice(0, 12).map((k) => (
              <figure key={k}>
                {/* These are FULL-PAGE captures — a 7000px-tall demo rendered at
                    column width turns one tab into a 20-screen scroll. Cropped to
                    a fixed window showing the top of the page; the full image is
                    one click away. */}
                <a
                  href={`/api/object?bucket=raw&key=${encodeURIComponent(k)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block no-underline"
                >
                <img
                  src={`/api/object?bucket=raw&key=${encodeURIComponent(k)}`}
                  alt="Скриншот демосайту з перевірки"
                  className="rounded-lg border border-line w-full h-56 object-cover object-top"
                />
                </a>
                {/* The object key ends in a hash, which tells the reader
                    nothing; the viewport it was taken at is the useful half. */}
                <figcaption className="text-sm text-ink-mute mt-1 truncate" title={k}>
                  {shotLabel(k)}
                </figcaption>
              </figure>
            ))}
          </div>
        </Panel>
      )}

      {project && (project.qaReportKey || (project.qaReportKeys as string[] | null)?.length) && (
        <Panel title="Звіти перевірки">
          <div className="flex gap-4 flex-wrap text-sm">
            <Link href={`/settings/system?business=${encodeURIComponent(biz.id)}`} className="link">
              Усі кроки збірки
            </Link>
            {((project.qaReportKeys as string[] | null) ?? []).map((k, i, arr) => (
              <Link key={k} href={`/businesses/${biz.id}/qa/${i + 1}`} className="link">
                {i === arr.length - 1 ? `Останній звіт (спроба ${i + 1})` : `Спроба ${i + 1}`}
              </Link>
            ))}
            {project.snapshotKey && (
              <Link href={`/businesses/${biz.id}/snapshot`} className="link">
                Факти збірки
              </Link>
            )}
          </div>
        </Panel>
      )}

      {/* The wow-video brief + upload slot. Rendered ONLY once the art
          director has written the brief (first build done): before that there
          is no design, no prompt, and nothing for Roman to act on — an empty
          form here was noise (2026-08-22). */}
      {heroVideoBrief && (
        <HeroVideoPanel
          businessId={biz.id}
          brief={heroVideoBrief}
          heroPhoto={startFrameRow ? {
            file: startFrameName!,
            url: `/api/object?bucket=assets&key=${encodeURIComponent(startFrameRow.objectKey)}`,
          } : null}
          currentClip={latestHeroClip
            ? { generator: latestHeroClip.generator, capturedAt: fmtDate(latestHeroClip.capturedAt) }
            : null}
        />
      )}
    </div>
  );

  // ── Контакти ──────────────────────────────────────────────────────────────
  const contactsTab = (
    <div className="space-y-4">
      <Panel title="Контакти">
        {contacts.length === 0 ? (
          <p className="text-sm text-ink-mute">Контактів ще не знайшли.</p>
        ) : (
          <ul>
            {contacts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 border-b border-line last:border-0">
                <span className="text-sm text-ink-soft w-28 shrink-0" title={c.channel}>
                  {humanChannel(c.channel)}
                </span>
                <span className="text-sm font-mono break-all flex-1">{c.value}</span>
                {c.verified && <Status tone="go">підтверджено</Status>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Соцмережі">
        <div className="space-y-4">
          <FindSocialsButton businessId={biz.id} state={socialsState} />
          <SocialsPanel
            contacts={socialContacts}
            unresolvedGap={gaps.some((g) => !g.resolved && g.gap === 'socials_unresolved')}
          />
        </div>
      </Panel>
    </div>
  );

  // ── Факти й джерела ───────────────────────────────────────────────────────
  const otherFacts = facts.filter((f) => !f.key.startsWith('brand.'));
  const factsTab = (
    <div className="space-y-4">
      {/* Two different things used to share this panel and one English voice:
          the HARD gates (a short list of keys the readiness gate refused on)
          and the SOFT notes (whole English sentences the enrichment agent
          writes). Rendering them together produced the 7-bullet English wall
          Roman saw (sweep P0-6). They are separated below: the gates are
          translated and lead; the agent's prose is folded away, labelled as
          the agent's own words rather than presented as the interface's. */}
      {hardGaps.length > 0 && (
        <Panel title="Чого бракує для демо">
          <ul className="space-y-1.5">
            {hardGaps.map((g) => (
              <li key={g.id} className="text-sm">
                <Status tone="stop" title={g.gap}>
                  {gapName(g.gap)} — блокує збірку
                </Status>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {softGaps.length > 0 && (
        <Panel title="Що фабрика не знайшла (не блокує)">
          <ul className="space-y-1.5">
            {softGaps.slice(0, 6).map((g) => (
              <li key={g.id} className="text-sm">
                <Status tone="wait" title={g.gap}>{softGapText(g.gap, g.gapUk)}</Status>
              </li>
            ))}
          </ul>
          {softGaps.length > 6 && (
            <details className="mt-3">
              <summary className="disclosure">
                ще {softGaps.length - 6}
              </summary>
              <ul className="mt-2 space-y-1.5 pl-4 border-l-2 border-line">
                {softGaps.slice(6).map((g) => (
                  <li key={g.id} className="text-sm text-ink-mute" title={g.gap}>
                    {softGapText(g.gap, g.gapUk)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {/* The agent's own words, in the language of the evidence it read.
              Kept because the Ukrainian above is a translation of a claim about
              a business — the reader must be able to check it against what the
              agent actually wrote, on the one tab whose job is provenance. */}
          {softGaps.some((g) => isSoftGapTranslated(g.gap, g.gapUk)) && (
            <details className="mt-3">
              <summary className="disclosure">
                оригінал — як написав агент
              </summary>
              <ul className="mt-2 space-y-1.5 pl-4 border-l-2 border-line">
                {softGaps.map((g) => (
                  <li key={g.id} className="text-sm text-ink-mute">{g.gap}</li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
      )}

      {/* The QA agent's reasoning. ~1,800 characters, written in English by the
          critic, and it used to be printed as one unbroken English paragraph
          directly on the page. It is genuinely useful — it is the record of
          what was checked — so it stays: Ukrainian (translated once at write
          time by `score.ts`), split into its own findings, with the critic's
          English original one fold further down. */}
      {criticNotes && (
        <Panel title="Перевірка фактів">
          <p className="text-sm text-ink-soft">{criticNotes.summary}</p>
          {criticNotes.findings.length > 0 && (
            // Unfolded when this report is WHY the business is waiting on Roman
            // — folding the thing the status asks him to read defeats the badge.
            <details className="mt-3" open={factCheckAttention}>
              <summary className="disclosure">
                звіт критика — {criticNotes.findings.length} зауваж.
              </summary>
              <ul className="mt-2 space-y-2.5 pl-4 border-l-2 border-line">
                {criticNotes.findings.map((f, i) => (
                  <li key={i} className="text-sm">
                    <span className={f.kind === 'CONTRADICTION' ? 'text-dot-stop' : 'text-dot-wait'}>
                      {f.kind === 'CONTRADICTION' ? 'суперечність' : 'підозріло'}
                    </span>
                    <span className="text-ink-mute"> · {f.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {criticNotesOriginal && criticNotesOriginal.findings.length > 0 && (
            <details className="mt-2">
              <summary className="disclosure">
                оригінал — як написав критик (EN)
              </summary>
              <ul className="mt-2 space-y-2.5 pl-4 border-l-2 border-line">
                {criticNotesOriginal.findings.map((f, i) => (
                  <li key={i} className="text-sm text-ink-mute">{f.kind}: {f.text}</li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
      )}

      {audit && (
        <Panel title="Їхній нинішній сайт">
          <div className="flex items-center gap-4 flex-wrap">
            <Status tone={verdict.tone} title={audit.verdict}>{verdict.text}</Status>
            <span className="text-sm text-ink-mute">{fmtDate(audit.auditedAt)}</span>
            {audit.bestEndpoint && (
              <span className="text-sm text-ink-mute font-mono truncate">{audit.bestEndpoint}</span>
            )}
          </div>
          {/* `audit.notes` is assembled from code-side templates, so it is
              rendered in Ukrainian by `parseAuditNotes` rather than translated
              by an agent — that also covers every row written before this
              existed. The English stays in the database for the build snapshot,
              which hands it to an English-reading builder agent. */}
          {auditNotes.length > 0 && (
            <ul className="mt-3 space-y-1.5 max-w-[70ch]">
              {auditNotes.map((n, i) => (
                <li key={i} className="text-sm">
                  <Status tone={n.severe ? 'stop' : 'wait'} title={n.original}>{n.text}</Status>
                </li>
              ))}
            </ul>
          )}
          <div className="grid sm:grid-cols-2 gap-3 mt-4">
            {audit.desktopScreenshotKey && (
              <img
                src={`/api/object?bucket=raw&key=${encodeURIComponent(audit.desktopScreenshotKey)}`}
                alt="Їхній сайт на комп’ютері"
                className="rounded-lg border border-line w-full"
              />
            )}
            {audit.mobileScreenshotKey && (
              <img
                src={`/api/object?bucket=raw&key=${encodeURIComponent(audit.mobileScreenshotKey)}`}
                alt="Їхній сайт на телефоні"
                className="rounded-lg border border-line w-full"
              />
            )}
          </div>
          {/* The viewport shots above show the top screen only, which is where a
              cookie banner and a not-yet-painted hero live. The full-page capture
              is what makes a verdict checkable by eye, so it gets its own link
              rather than being inlined at full height. */}
          {audit.desktopFullScreenshotKey && (
            <a
              href={`/api/object?bucket=raw&key=${encodeURIComponent(audit.desktopFullScreenshotKey)}`}
              target="_blank"
              rel="noreferrer"
              className="link text-sm mt-3"
            >
              Вся сторінка цілком ↗
            </a>
          )}
        </Panel>
      )}

      {/* The measured brand identity, above the raw fact list: it is what the
          demo's palette is built from, and it is the answer to "чи береш їхні
          кольори?". Renders nothing when no brand.* facts exist. */}
      <BrandSwatches facts={facts} sources={sources} />

      {/* Outside BrandSwatches on purpose: that component renders nothing when
          a business has no brand.* facts at all, and "no identity was measured"
          is exactly the case where a person most wants to press this. */}
      <RefreshBrandButton businessId={biz.id} />

      {/* `brand.*` rows are rendered above as swatches; repeating them here as
          JSON blobs would bury the readable facts under colour arrays. */}
      {/* The facts themselves. Previously: a flat list in database insertion
          order, keys as raw snake_case, values as `JSON.stringify` — the tab
          that exists to PROVE the factory invents nothing was the least
          readable page in the console (sweep P0-6).

          Now: grouped by meaning, keys in words (raw key kept as the tooltip),
          values rendered as the thing each one is, and every row carrying its
          evidence — the captured immutable copy first, the live page second
          (sweep P1-5). */}
      {otherFacts.length === 0 ? (
        <Panel title="Факти">
          <p className="text-sm text-ink-mute">Фактів ще немає.</p>
        </Panel>
      ) : (
        groupFacts(otherFacts).map((group) => (
          <Panel key={group.id} title={`${group.title} (${group.facts.length})`}>
            <ul>
              {group.facts.map((f) => {
                const src = f.sourceId ? sourceById.get(f.sourceId) : null;
                return (
                  <li key={f.id} className="py-3 border-b border-line last:border-0">
                    <div className="flex justify-between gap-3 items-baseline flex-wrap">
                      {/* The raw key stays reachable as a tooltip: this is an
                          evidence page, and the machine name is part of the
                          record even when it is not what a person reads. */}
                      <span className="text-sm text-ink-mute" title={f.key}>
                        {factLabel(f.key)}
                      </span>

                      <span className="flex items-baseline gap-3 shrink-0">
                        {src?.rawObjectKey && (
                          // The IMMUTABLE captured copy — what the fact was
                          // actually extracted from. This is the link that makes
                          // "every fact has a source" checkable; the live page
                          // can change or disappear, this cannot.
                          <a
                            href={`/api/object?bucket=raw&key=${encodeURIComponent(src.rawObjectKey)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="link text-sm"
                            title={`Збережена копія джерела · ${src.method ?? ''}`}
                          >
                            доказ
                          </a>
                        )}
                        {src ? (
                          <a
                            href={safeHttpUrl(src.url)}
                            target="_blank"
                            rel="noreferrer"
                            className="link-quiet text-sm"
                            title={src.url ?? undefined}
                          >
                            оригінал ↗
                          </a>
                        ) : (
                          // A fact with no source can never become verified
                          // (SPEC §5). Showing that is the point.
                          <span className="text-sm text-dot-wait">без джерела</span>
                        )}
                      </span>
                    </div>

                    <div className="mt-1">
                      <FactValue factKey={f.key} value={f.value} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ))
      )}
    </div>
  );

  // ── Фото ──────────────────────────────────────────────────────────────────
  const photosTab = (
    <Panel>
      {assetRows.length === 0 ? (
        <p className="text-sm text-ink-mute">Фотографій ще не зібрали.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {assetRows.map((a) => (
            <figure key={a.id}>
              {(a.contentType ?? '').startsWith('video') ? (
                <video
                  src={`/api/object?bucket=assets&key=${encodeURIComponent(a.objectKey)}`}
                  className="rounded-lg border border-line w-full aspect-square object-cover"
                  muted loop
                />
              ) : (
                <img
                  src={`/api/object?bucket=assets&key=${encodeURIComponent(a.objectKey)}`}
                  alt={a.intendedUsage}
                  className="rounded-lg border border-line w-full aspect-square object-cover"
                />
              )}
              <figcaption className="text-sm text-ink-mute mt-1">
                {a.intendedUsage}
                {/* AI media may never pass as a real photo of the business
                    (SPEC invariants) — this label is part of that guarantee. */}
                {a.aiGenerated && <span className="text-dot-wait"> · згенеровано ШІ</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Panel>
  );

  // ── Історія ───────────────────────────────────────────────────────────────
  const historyTab = (
    <Panel title="Що з ним відбувалось">
      <ol className="space-y-2.5">
        {history.map((h) => (
          <li key={h.id} className="text-sm flex gap-3">
            <span className="text-ink-mute tabular-nums shrink-0 w-28">{fmtDate(h.at)}</span>
            {/* A <div> here would sit inside a <span>, which the browser
                reparents — and a DOM that differs from the server render is a
                React hydration error (#418). Block content needs a block box. */}
            <div className="min-w-0">
              <Status tone={humanStatus(h.toStatus).tone} title={h.toStatus}>
                {humanStatus(h.toStatus).text}
              </Status>
              {/* Actor and reason are both machine vocabulary in the database
                  (`readiness-gate`, `gaps: assets_min3`, English QA prose) and
                  both used to render raw (sweep P1-10). Translated here; the
                  raw record is one hover away and untouched in the DB. */}
              <span className="text-ink-mute" title={h.actor}> · {humanActor(h.actor)}</span>
              {h.reason && (
                <div className="text-ink-mute" title={h.reason}>
                  {historyReason(h.reason)}
                </div>
              )}
            </div>
          </li>
        ))}
        {history.length === 0 && <li className="text-sm text-ink-mute">Історія порожня.</li>}
      </ol>
    </Panel>
  );

  // ── Розмова (what /conversations used to be, per business) ────────────────
  const replyEvents = events.filter((e) => ['replied', 'opted_out', 'bounced'].includes(e.event));
  const conversationTab = (
    <div className="space-y-4" id="rozmova">
      {deal && <DealStageForm businessId={biz.id} state={deal.state} />}

      <Panel title="Листування">
        {messages.length === 0 && replyEvents.length === 0 ? (
          <p className="text-sm text-ink-mute">Поки нічого не писали.</p>
        ) : (
          <div className="space-y-5">
            {messages.map((m) => (
              <div key={m.id} className="pl-4 border-l-2 border-line">
                <p className="text-sm text-ink-mute">
                  Ми · {humanChannel(m.channel)} · {fmtDate(m.sentAt)}
                  {' · '}<span title={m.state}>{humanMessageState(m.state)}</span>
                </p>
                {m.subject && <p className="text-sm font-medium mt-1">{m.subject}</p>}
                <p className="text-sm text-ink-soft whitespace-pre-wrap mt-1">{m.body}</p>
              </div>
            ))}
            {replyEvents.map((e) => (
              <div key={e.id} className="pl-4 border-l-2 border-dot-go">
                <p className="text-sm text-ink-mute" title={e.event}>
                  Вони · {humanOutreachEvent(e.event)} · {fmtDate(e.at)}
                </p>
                <p className="text-sm text-ink-soft whitespace-pre-wrap mt-1">
                  {String((e.detail as Record<string, unknown> | null)?.preview ?? '')}
                </p>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );

  const tabs: TabDef[] = [
    { id: 'demo', label: 'Демо', content: demoTab },
    { id: 'contacts', label: 'Контакти', count: contacts.length, content: contactsTab },
    { id: 'facts', label: 'Факти й джерела', count: facts.length, content: factsTab },
    { id: 'photos', label: 'Фото', count: assetRows.length, content: photosTab },
  ];
  if (messages.length || replyEvents.length || deal) {
    tabs.push({ id: 'talk', label: 'Розмова', count: messages.length, content: conversationTab });
  }
  tabs.push({ id: 'history', label: 'Історія', content: historyTab });

  return (
    <div>
      {/* ── header: who and where they stand. What to DO is the band below. ── */}
      <div className="mb-5">
        <Link href="/businesses" className="link-quiet text-sm">
          ← Бізнеси
        </Link>

        <h1 className="h-page mt-3">{biz.name}</h1>

        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-2">
          <Status tone={status.tone} title={biz.status}>{status.text}</Status>
          <Status tone={verdict.tone} title={audit?.verdict}>{verdict.text}</Status>
          {biz.score !== null && <span className="text-sm text-ink-soft">бал {biz.score}</span>}
        </div>

        {/* «Демо: …» — the answer to the question this card is opened for,
            in the shared five-word vocabulary; the band below is what to do
            about it. A skipped or cancelled attempt never shows as progress. */}
        <p className="mt-2 text-sm flex items-center gap-x-2 flex-wrap">
          <span className="text-ink-mute">Демо:</span>
          <Status tone={demo.tone} title={project?.state ?? undefined}>{demo.text}</Status>
          {demo.detail && <span className="text-ink-soft">· {demo.detail}</span>}
          {demo.key === 'ready' && project?.deployUrl && (
            <a href={safeHttpUrl(project.deployUrl)} target="_blank" rel="noreferrer" className="link">
              Відкрити демо ↗
            </a>
          )}
        </p>

        <p className="text-sm text-ink-mute mt-1.5">
          {[biz.category, biz.address].filter(Boolean).join(' · ') || '—'}
        </p>

        {/* Only when the pipeline's reason is a sentence a person can read. A
            bare URL or a snake_case token stays in the Історія tab. */}
        {headerReason && (
          <p className="text-sm text-ink-soft mt-2 max-w-[70ch]">{headerReason}</p>
        )}

        <div className="flex gap-4 mt-3 text-sm flex-wrap">
          {biz.phone && <span className="text-ink-soft">{biz.phone}</span>}
          {biz.websiteUrl && (
            <a href={safeHttpUrl(biz.websiteUrl)} target="_blank" rel="noreferrer" className="link">
              {linkLabel(biz.websiteUrl)} ↗
            </a>
          )}
          {biz.listingUrl && (
            <a href={safeHttpUrl(biz.listingUrl)} target="_blank" rel="noreferrer" className="link">
              Google Maps ↗
            </a>
          )}
          <Link href={`/businesses?campaign=${encodeURIComponent(biz.campaignId)}`} className="link">
            {biz.campaignId}
          </Link>
        </div>

      </div>

      {/* ── what to do about it, before any of the reading material ──
          Roman's rule: opening a business and having to scroll past four screens
          of facts to find the button is the interface failing at its one job.

          NOT wrapped in a spacing <div>: the band is `position: sticky` on a
          phone, and a sticky box can only travel inside its own parent. A wrapper
          sized to the band itself gives it nowhere to go, so it scrolls away like
          any other element. Its bottom margin is its own. */}
      <CardActionBar
        bar={actionBar}
        businessId={biz.id}
        name={biz.name}
        status={biz.status}
        other={(
          <OtherActionsDialog
            businessId={biz.id}
            name={biz.name}
            currentStatus={biz.status}
            statuses={[...BUSINESS_STATUSES]}
          />
        )}
      />

      <Tabs tabs={tabs} initial={factCheckAttention ? 'facts' : undefined} />
    </div>
  );
}
