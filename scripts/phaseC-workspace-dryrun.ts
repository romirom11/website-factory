/**
 * Workspace preparation dry-run: builds a real workspace from a synthetic brief
 * and design contract WITHOUT calling any agent, then verifies the invariants the
 * builder depends on. Cheap to run and catches plumbing bugs before a 30-minute
 * agent session discovers them.
 *
 *   pnpm tsx scripts/phaseC-workspace-dryrun.ts <businessId>
 */
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/client.js';
import { buildSnapshot } from '../src/build/snapshot.js';
import { prepareWorkspace } from '../src/build/workspace.js';
import { chooseDirection } from '../src/build/rubric.js';
import { loadMotionIndex } from '../src/build/motionRefs.js';
import type { ArtDirection, ContentBrief, DirectionScore } from '../src/build/schemas.js';
import { assertFixtureId } from './e2e/safety.js';

const businessId = assertFixtureId(process.argv[2] ?? 'e2e-phasec-anemi-studio', 'business ID');
const PROJECT_ID = 999999; // sentinel: never collides with a real project

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const snapshot = await buildSnapshot(businessId);
console.log(`snapshot: ${snapshot.name} | ${snapshot.services.length} services, ${snapshot.reviews.length} reviews, ` +
  `${snapshot.contacts.length} contacts, ${snapshot.assets.length} assets, lang=${snapshot.language}`);

const brief: ContentBrief = {
  language: snapshot.language,
  businessOneLiner: 'Δοκιμαστικό one-liner.',
  mainOffer: 'Δοκιμή',
  primaryCta: { label: 'Καλέστε μας', href: `tel:${snapshot.contacts[0]?.value ?? ''}`, rationale: 'phone' },
  toneOfVoice: 'ήρεμο',
  sections: [
    { id: 'hero', name: 'Hero', purpose: 'p', contentSummary: 'c', usesSnapshotPaths: ['name'], priority: 1 },
    { id: 'services', name: 'Υπηρεσίες', purpose: 'p', contentSummary: 'c', usesSnapshotPaths: ['services'], priority: 2 },
    { id: 'contact', name: 'Επικοινωνία', purpose: 'p', contentSummary: 'c', usesSnapshotPaths: ['contacts'], priority: 3 },
  ],
  allowedClaims: [],
  forbiddenClaims: ['award-winning'],
  omissions: [],
  copyConstraints: { maxHeadlineWords: 8, maxParagraphSentences: 3, bannedPhrases: ['Elevate'] },
};

const heroAsset = snapshot.assets.find((a) => !a.aiGenerated) ?? null;
const design: ArtDirection = {
  name: 'Dry Run',
  bigIdea: 'plumbing test',
  layoutSkeleton: [
    { sectionId: 'hero', composition: 'full bleed photo', heightFeel: 'full-bleed' },
    { sectionId: 'services', composition: 'type list', heightFeel: 'tight' },
    { sectionId: 'contact', composition: 'hairline box', heightFeel: 'medium' },
  ],
  typography: { displayFont: 'GFS_Didot', bodyFont: 'Manrope', hierarchyRule: 'size contrast', microLabelTreatment: 'caps 11px' },
  palette: { background: '#f6f2ec', foreground: '#1d1815', accent: '#7d4a35', accentUsage: 'once', derivedFrom: 'hero photo' },
  motionConcept: { idea: 'reveal', techniques: ['BlurFade'], reducedMotionPlan: 'static' },
  heroTreatment: { kind: heroAsset ? 'real-photo-full-bleed' : 'typographic', assetFile: heroAsset?.file ?? null, description: 'hero' },
  poolComponents: ['BlurFade'],
  reference: { name: 'Salón Soňa', borrowedMechanics: ['split hero'] },
  referenceSlug: 'vero-studio',
  mechanics: [
    { name: 'roman/italic mixed headline', component: 'SplitHeadline', where: 'hero' },
    { name: 'amber photo grade over every image', component: 'css', where: 'all photos' },
    { name: 'vertical split-screen wipe', component: 'SplitScreenWipe', where: 'services' },
  ],
  heroMotion: heroAsset ? 'kenburns' : 'none',
  heroMotionJustification: heroAsset ? null : 'no real photograph in the evidence package',
  preloader: true,
  typeAsDesign: 'display serif at 9vw against 13px letterspaced caps',
  photoGrade: 'grade-warm',
};

const scores: DirectionScore[] = [{
  name: 'Dry Run', structuralDistinctiveness: 7, evidenceFit: 7, typographicCraft: 7,
  referenceGrounding: 7, motionRestraint: 7, slopRisk: 1, buildRisk: 1,
  wow: {
    heroMotion: heroAsset ? 3 : 0, scrollChoreography: 2, typeAsDesign: 3,
    photoTreatment: 2, microInteraction: 2, performanceReducedMotion: 2,
  },
  detectedSlopTells: [], reasoning: 'dry run',
}];
const motionIndex = await loadMotionIndex();
const verdict = chooseDirection([design], scores, snapshot, motionIndex.map((e) => e.slug));
console.log(`rubric: ${verdict.rationale}`);

const plan = await prepareWorkspace({
  snapshot, brief, design, verdict,
  heroMedia: {
    kind: heroAsset ? 'ken-burns' : 'none',
    file: null, sourceFile: heroAsset?.file ?? null, aiGenerated: false,
    durationSec: 20, respectReducedMotion: true, note: 'dry run',
  },
  projectId: PROJECT_ID, niche: 'beauty', fresh: true,
});

const dir = plan.dir;
console.log(`workspace: ${dir}`);

// ── invariants the builder agent depends on ─────────────────────────────────
check('template copied (package.json)', existsSync(path.join(dir, 'package.json')));
check('own pnpm-workspace.yaml copied (install stays self-contained)',
  existsSync(path.join(dir, 'pnpm-workspace.yaml')));
check('node_modules NOT copied', !existsSync(path.join(dir, 'node_modules')));
check('.next NOT copied', !existsSync(path.join(dir, '.next')));
check('out/ NOT copied', !existsSync(path.join(dir, 'out')));
check('DESIGN.md present', existsSync(path.join(dir, 'DESIGN.md')));
check('component pool present', existsSync(path.join(dir, 'components', 'ui', 'blur-fade.tsx')));
check('BUILD-TASK.md written', existsSync(path.join(dir, 'BUILD-TASK.md')));
check('MEDIA-MANIFEST.json written', existsSync(path.join(dir, 'MEDIA-MANIFEST.json')));
check('input/snapshot.json written', existsSync(path.join(dir, 'input', 'snapshot.json')));
check('input/brief.json written', existsSync(path.join(dir, 'input', 'brief.json')));
check('input/design.json written', existsSync(path.join(dir, 'input', 'design.json')));
check('input/rubric.json written', existsSync(path.join(dir, 'input', 'rubric.json')));
check('gsap skills copied', existsSync(path.join(dir, '.claude', 'skills', 'gsap-scrolltrigger', 'SKILL.md')));
check('references copied', existsSync(path.join(dir, 'references', 'beauty', 'README.md')));
// The motion pack is 60MB of mostly video; only the ONE chosen reference's
// readable files go into a workspace.
check('chosen motion reference notes copied',
  existsSync(path.join(dir, 'references', design.referenceSlug, 'notes.md')));
check('chosen motion reference hero.jpg copied (the critic compares against it)',
  existsSync(path.join(dir, 'references', design.referenceSlug, 'hero.jpg')));
check('chosen motion reference full.jpg copied',
  existsSync(path.join(dir, 'references', design.referenceSlug, 'full.jpg')));
check('motion reference VIDEO not copied (the agent cannot watch it)',
  !existsSync(path.join(dir, 'references', design.referenceSlug, 'desktop.webm')));
check('the other 16 motion references are NOT copied',
  !existsSync(path.join(dir, 'references', 'motion')) && !existsSync(path.join(dir, 'references', 'omr-beauty')));
check('no stale result.json', !existsSync(path.join(dir, 'result.json')));

check('assets materialized', plan.assetFiles.length === snapshot.assets.filter((a) => !a.aiGenerated).length,
  `${plan.assetFiles.length} files`);
for (const f of plan.assetFiles) {
  check(`  asset on disk: ${f}`, existsSync(path.join(dir, 'public', f)));
}

const task = await readFile(path.join(dir, 'BUILD-TASK.md'), 'utf8');
check('BUILD-TASK names the business', task.includes(snapshot.name));
check('BUILD-TASK lists the real contacts',
  snapshot.contacts.every((c) => task.includes(c.value)),
  snapshot.contacts.map((c) => c.value).join(', '));
check('BUILD-TASK states the language', task.includes(snapshot.languageName));
check('BUILD-TASK carries the Greek font trap when the site is Greek',
  !snapshot.language.startsWith('el') || task.includes('GREEK FONT TRAP'));
check('BUILD-TASK names the chosen direction', task.includes(design.name));
check('BUILD-TASK names the reference', task.includes(design.reference.name));
check('BUILD-TASK forbids invented facts', /No invented services, prices/.test(task));
check('BUILD-TASK names the motion reference slug', task.includes(design.referenceSlug));
check('BUILD-TASK lists every mechanic with its component',
  design.mechanics.every((m) => task.includes(m.name) && task.includes(m.component)));
check('BUILD-TASK states the hero motion device', task.includes(`Hero motion: \`${design.heroMotion}\``));
check('BUILD-TASK carries the six wow axes and the gate',
  task.includes('scrollChoreography') && task.includes('performanceReducedMotion')
  && task.includes('ALL THREE must hold'));
check('BUILD-TASK caps the preloader at 1.2s', !design.preloader || task.includes('1.2s'));
check('BUILD-TASK names the photo grade', !design.photoGrade || task.includes(design.photoGrade));
check('BUILD-TASK states the performance budget (no WebGL)', task.includes('No WebGL'));
check('BUILD-TASK requires reduced motion to leave nothing at opacity 0',
  task.includes('opacity: 0'));
check('BUILD-TASK carries the Greek italic rule when the site is Greek',
  !snapshot.language.startsWith('el') || task.includes('EB_Garamond'));

const manifest = JSON.parse(await readFile(path.join(dir, 'MEDIA-MANIFEST.json'), 'utf8'));
check('manifest marks non-AI assets as depicting the business',
  manifest.assets.filter((a: any) => !a.aiGenerated).every((a: any) => a.mayDepictTheBusiness === true));
check('manifest marks AI assets as NOT depicting the business',
  manifest.assets.filter((a: any) => a.aiGenerated).every((a: any) => a.mayDepictTheBusiness === false));

const writtenSnapshot = JSON.parse(await readFile(path.join(dir, 'input', 'snapshot.json'), 'utf8'));
check('written snapshot has no DB internals leaking beyond source ids',
  Array.isArray(writtenSnapshot.sources) && writtenSnapshot.sources.every((s: any) => typeof s.id === 'number'));

if (process.argv.includes('--keep')) {
  console.log(`\nworkspace kept at ${dir}`);
} else {
  await rm(dir, { recursive: true, force: true });
}
await pool.end();
console.log(`\n${failures === 0 ? '✅ workspace dry-run passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
