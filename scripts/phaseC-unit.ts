/**
 * Phase C unit checks — the pure, deterministic parts of the build pipeline.
 * No DB, no network, no agents. Run: pnpm tsx scripts/phaseC-unit.ts
 *
 * These cover exactly the logic that must NOT depend on a model behaving well:
 * the rubric that picks a design, and the provenance check that catches an agent
 * inventing a phone number.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  brandNeglect, chooseDirection, routeDesignGate, scoreDirection, vetoesFor,
} from '../src/build/rubric.js';
import { checkProvenance } from '../src/build/provenance.js';
import { unusableContactReason } from '../src/build/snapshot.js';
import {
  WOW_FAIL_THRESHOLD, WOW_MAX, condenseNotes, parseMotionIndex,
  shortlistReferences, wowTotal, wowVerdict,
} from '../src/build/motionRefs.js';
import type { ArtDirection, DirectionScore, WowScores } from '../src/build/schemas.js';
import type { BuildSnapshot } from '../src/build/snapshot.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const snapshot: BuildSnapshot = {
  snapshotVersion: 1,
  capturedAt: new Date().toISOString(),
  businessId: 'gr-patras-unit',
  campaignId: 'unit',
  name: 'Nail Studio Aigli',
  category: 'Nail salon',
  address: 'Riga Feraiou 12, Patras',
  city: 'Patras',
  language: 'el',
  languageName: 'Greek (Ελληνικά)',
  description: { value: 'Στούντιο νυχιών στο κέντρο.', sourceIds: [1], confidence: 0.9 },
  hours: null,
  rating: 4.9,
  reviewCount: 61,
  services: [
    { value: { name: 'Manicure', price: '15€', description: null }, sourceIds: [1], confidence: 0.9 },
    { value: { name: 'Pedicure', price: '20€', description: null }, sourceIds: [1], confidence: 0.9 },
    { value: { name: 'Gel', price: null, description: null }, sourceIds: [1], confidence: 0.8 },
  ],
  reviews: [],
  socials: { instagram: 'https://instagram.com/nailstudioaigli' },
  contacts: [
    { channel: 'phone', value: '+30 2610 123456', verified: true, sourceIds: [1] },
    { channel: 'email', value: 'info@aigli.gr', verified: true, sourceIds: [2] },
  ],
  otherFacts: [],
  assets: [
    { file: 'assets/hero-abc.jpg', objectKey: 'x/hero-abc.jpg', kind: 'hero', width: 1600, height: 1067, contentType: 'image/jpeg', aiGenerated: false, generator: null, sourceUrl: 'https://example.gr/1.jpg' },
    { file: 'generated/background-def.png', objectKey: 'x/background-def.png', kind: 'background', width: 1536, height: 1024, contentType: 'image/png', aiGenerated: true, generator: 'gen-image:gpt-image-2', sourceUrl: 'generated://gen-image' },
  ],
  // A measured identity: a warm terracotta accent off the logo, the shape the
  // real Patras extractions produce.
  brand: {
    paletteSource: 'logo',
    primary: { hex: '#8a3b2a', from: 'logo asset logo-abc.png', sourceIds: [1] },
    accent: {
      hex: '#c8a15a', from: 'logo asset logo-abc.png', sourceIds: [1],
      onLight: '#8a6a2e', onDark: '#c8a15a',
    },
    logoColors: {
      from: 'logo asset logo-abc.png', sourceIds: [1],
      colors: [
        { hex: '#8a3b2a', share: 0.6, hsl: { h: 12, s: 0.53, l: 0.35 } },
        { hex: '#c8a15a', share: 0.2, hsl: { h: 39, s: 0.51, l: 0.57 } },
      ],
    },
    avatarColors: null, siteColors: null, photoColors: null,
    fontsSeen: null,
    voice: {
      tone: 'warm', formality: 'casual',
      selfDescribedAs: ['φιλικό στούντιο'], statedBrandElements: [], sourceIds: [1],
    },
  },
  website: { url: null, verdict: 'none', meaningfulContent: null, notes: null },
  openGaps: [],
  sources: [{ id: 1, type: 'google_maps', url: 'https://maps.google.com/x', capturedAt: new Date().toISOString(), method: 'gosom_api' }],
};

function direction(over: Partial<ArtDirection> = {}): ArtDirection {
  return {
    name: 'Base',
    bigIdea: 'idea',
    layoutSkeleton: [
      { sectionId: 'hero', composition: 'full bleed', heightFeel: 'full-bleed' },
      { sectionId: 'services', composition: 'list', heightFeel: 'tight' },
      { sectionId: 'contact', composition: 'type', heightFeel: 'medium' },
    ],
    typography: { displayFont: 'GFS_Didot', bodyFont: 'Manrope', hierarchyRule: 'size', microLabelTreatment: 'caps' },
    palette: {
      background: '#fff', foreground: '#111', accent: '#8a3b2a', accentUsage: 'once',
      derivedFrom: 'hero photo', paletteSource: 'brand',
      brandAlignment: 'accent is the logo terracotta #8a3b2a',
    },
    motionConcept: { idea: 'reveal', techniques: ['blurfade'], reducedMotionPlan: 'static' },
    heroTreatment: { kind: 'real-photo-full-bleed', assetFile: 'assets/hero-abc.jpg', description: 'photo' },
    poolComponents: ['BlurFade'],
    reference: { name: 'Salón Soňa', borrowedMechanics: ['split hero'] },
    referenceSlug: 'vero-studio',
    mechanics: [
      { name: 'roman/italic mixed headline', component: 'SplitHeadline', where: 'hero' },
      { name: 'amber photo grade', component: 'css', where: 'all photos' },
      { name: 'vertical split-screen wipe', component: 'SplitScreenWipe', where: 'services' },
    ],
    heroMotion: 'kenburns',
    heroMotionJustification: null,
    preloader: true,
    typeAsDesign: 'display serif at 9vw against 13px letterspaced caps',
    photoGrade: 'grade-warm',
    // Contract v2/v3 required fields (signature + sceneMap + the art-director
    // video brief with its named real start frame) — the fixture must satisfy
    // the same vetoes production directions do.
    signature: 'the amber seam dividing hero from services',
    sceneMap: {
      system: 'power2.out everywhere, 0.6/0.9/1.2s scale',
      scenes: [
        { section: 'hero', trigger: 'load', motion: 'headline split rises', handoff: 'seam wipes down' },
        { section: 'services', trigger: 'scrub', motion: 'rows slide in', handoff: 'fade to contact' },
        { section: 'contact', trigger: 'enter', motion: 'type settles', handoff: 'page end' },
      ],
    },
    heroVideoBrief: '8-second landscape clip from the attached photograph; one slow push-in, warm key light, nothing added or morphed.',
    heroVideoStartFrame: 'assets/hero-abc.jpg',
    ...over,
  };
}

/** A wow profile that clears the 9/18 floor with room to spare (15/18). */
function wow(over: Partial<WowScores> = {}): WowScores {
  return {
    heroMotion: 3, scrollChoreography: 2, typeAsDesign: 3,
    photoTreatment: 3, microInteraction: 2, performanceReducedMotion: 2,
    ...over,
  };
}

function score(over: Partial<DirectionScore> = {}): DirectionScore {
  return {
    name: 'Base',
    structuralDistinctiveness: 7, evidenceFit: 7, typographicCraft: 7,
    referenceGrounding: 7, motionRestraint: 7, brandFit: 7, slopRisk: 2, buildRisk: 2,
    wow: wow(),
    detectedSlopTells: [], reasoning: 'ok',
    ...over,
  };
}

/** Slugs the pipeline passes in from the on-disk pack; the tests use a fixed set. */
const KNOWN_SLUGS = ['vero-studio', 'omr-beauty', 'izanami'] as const;

// ── rubric: hard vetoes ─────────────────────────────────────────────────────

check('greek-safe font pair passes', vetoesFor(direction(), snapshot).length === 0);

check('non-greek display font vetoed on a Greek site',
  vetoesFor(direction({
    typography: { displayFont: 'Fraunces', bodyFont: 'Manrope', hierarchyRule: 'x', microLabelTreatment: 'y' },
  }), snapshot).some((v) => v.reason.includes('Fraunces')));

check('non-greek body font vetoed on a Greek site',
  vetoesFor(direction({
    typography: { displayFont: 'GFS_Didot', bodyFont: 'Outfit', hierarchyRule: 'x', microLabelTreatment: 'y' },
  }), snapshot).some((v) => v.reason.includes('Outfit')));

check('banned display font vetoed',
  vetoesFor(direction({
    typography: { displayFont: 'Inter', bodyFont: 'Manrope', hierarchyRule: 'x', microLabelTreatment: 'y' },
  }), { ...snapshot, language: 'en' }).some((v) => v.reason.includes('ban-list')));

check('hero asset that does not exist is vetoed',
  vetoesFor(direction({
    heroTreatment: { kind: 'real-photo-full-bleed', assetFile: 'assets/nope.jpg', description: 'x' },
  }), snapshot).some((v) => v.reason.includes('not in the snapshot')));

check('AI image used as a real-photo hero is vetoed',
  vetoesFor(direction({
    heroTreatment: { kind: 'real-photo-full-bleed', assetFile: 'generated/background-def.png', description: 'x' },
  }), snapshot).some((v) => v.reason.includes('ai_generated')));

check('real-photo hero with no asset named is vetoed',
  vetoesFor(direction({
    heroTreatment: { kind: 'real-photo-split', assetFile: null, description: 'x' },
  }), snapshot).some((v) => v.reason.includes('names no asset')));

check('more than 4 pool components vetoed',
  vetoesFor(direction({ poolComponents: ['a', 'b', 'c', 'd', 'e'] }), snapshot)
    .some((v) => v.reason.includes('cap is 4')));

check('reviews section without verified reviews is vetoed',
  vetoesFor(direction({
    layoutSkeleton: [
      { sectionId: 'hero', composition: 'x', heightFeel: 'tall' },
      { sectionId: 'reviews', composition: 'x', heightFeel: 'medium' },
      { sectionId: 'contact', composition: 'x', heightFeel: 'tight' },
    ],
  }), snapshot).some((v) => v.reason.includes('no verified reviews')));

check('reviews section IS allowed when reviews exist',
  vetoesFor(direction({
    layoutSkeleton: [
      { sectionId: 'hero', composition: 'x', heightFeel: 'tall' },
      { sectionId: 'reviews', composition: 'x', heightFeel: 'medium' },
      { sectionId: 'contact', composition: 'x', heightFeel: 'tight' },
    ],
  }), { ...snapshot, reviews: [{ value: { text: 'great', rating: 5, author: null }, sourceIds: [1], confidence: 0.9 }] })
    .length === 0);

// ── veto classification: what building can and cannot repair ────────────────
// The gate's routing hangs off `repairable`, so the flag itself is asserted per
// veto family — not just the reason text (code review 2026-08-23, finding #1).

check('a font veto is REPAIRABLE (the builder swaps the font)',
  vetoesFor(direction({
    typography: { displayFont: 'Fraunces', bodyFont: 'Manrope', hierarchyRule: 'x', microLabelTreatment: 'y' },
  }), snapshot).every((v) => v.repairable));

check('a pool-component overflow is REPAIRABLE (the builder drops components)',
  vetoesFor(direction({ poolComponents: ['a', 'b', 'c', 'd', 'e'] }), snapshot)
    .every((v) => v.repairable));

check('a hero asset that does not exist is UNREPAIRABLE (evidence violation)',
  vetoesFor(direction({
    heroTreatment: { kind: 'real-photo-full-bleed', assetFile: 'assets/nope.jpg', description: 'x' },
  }), snapshot).some((v) => !v.repairable && v.reason.includes('not in the snapshot')));

check('an AI image passed off as a real photo is UNREPAIRABLE',
  vetoesFor(direction({
    heroTreatment: { kind: 'real-photo-full-bleed', assetFile: 'generated/background-def.png', description: 'x' },
  }), snapshot).some((v) => !v.repairable && v.reason.includes('ai_generated')));

check('a reviews section without verified reviews is UNREPAIRABLE',
  vetoesFor(direction({
    layoutSkeleton: [
      { sectionId: 'hero', composition: 'x', heightFeel: 'tall' },
      { sectionId: 'reviews', composition: 'x', heightFeel: 'medium' },
      { sectionId: 'contact', composition: 'x', heightFeel: 'tight' },
    ],
  }), snapshot).some((v) => !v.repairable && v.reason.includes('no verified reviews')));

check('a false brand claim is UNREPAIRABLE',
  vetoesFor(direction({
    palette: {
      background: '#fff', foreground: '#111', accent: '#2244ff',
      accentUsage: 'buttons', derivedFrom: 'the reference', paletteSource: 'brand',
      brandAlignment: 'took the reference blue',
    },
  }), snapshot, KNOWN_SLUGS).some((v) => !v.repairable && v.reason.includes('within reach of any')));

// ── the design gate's routing: retry once, then build or escalate ───────────
{
  const clean = chooseDirection([direction()], [score()], snapshot, KNOWN_SLUGS);
  check('clean contract on attempt 1 goes straight to build',
    routeDesignGate(clean, 1).action === 'build');
  check('clean contract on attempt 2 also builds',
    routeDesignGate(clean, 2).action === 'build');

  // Repairable-only defect: a banned display font on a non-Greek site.
  const repairableOnly = chooseDirection(
    [direction({ typography: { displayFont: 'Inter', bodyFont: 'Manrope', hierarchyRule: 'x', microLabelTreatment: 'y' } })],
    [score()], { ...snapshot, language: 'en' }, KNOWN_SLUGS,
  );
  const r1 = routeDesignGate(repairableOnly, 1);
  check('repairable veto on attempt 1 → retry stage 9, with the veto as feedback',
    r1.action === 'retry' && r1.reasons.some((x) => x.includes('ban-list')));
  const r2 = routeDesignGate(repairableOnly, 2);
  check('repairable veto on attempt 2 → STILL BUILDS (the builder resolves it)',
    r2.action === 'build' && r2.openVetoes.some((x) => x.includes('ban-list')),
    JSON.stringify(r2));

  // Unrepairable defect: the hero names an asset the snapshot does not have.
  const evidenceViolation = chooseDirection(
    [direction({ heroTreatment: { kind: 'real-photo-full-bleed', assetFile: 'assets/nope.jpg', description: 'x' } })],
    [score()], snapshot, KNOWN_SLUGS,
  );
  check('unrepairable veto on attempt 1 → retry first (one retry is always owed)',
    routeDesignGate(evidenceViolation, 1).action === 'retry');
  const e2 = routeDesignGate(evidenceViolation, 2);
  check('unrepairable veto on attempt 2 → NeedsHuman, never a 40-90 min build',
    e2.action === 'needs_human' && e2.reasons.some((x) => x.includes('not in the snapshot')),
    JSON.stringify(e2));

  // A wow floor missed twice escalates even with zero vetoes.
  const weak = chooseDirection(
    [direction()],
    [score({ wow: wow({ heroMotion: 1, scrollChoreography: 1, typeAsDesign: 1, photoTreatment: 1, microInteraction: 1, performanceReducedMotion: 1 }) })],
    snapshot, KNOWN_SLUGS,
  );
  check('wow floor missed on attempt 1 → retry', routeDesignGate(weak, 1).action === 'retry');
  check('wow floor missed on attempt 2 → NeedsHuman',
    routeDesignGate(weak, 2).action === 'needs_human');
}

// ── rubric: scoring and choice ──────────────────────────────────────────────

{
  const high = scoreDirection(score({ structuralDistinctiveness: 9, slopRisk: 0 }), 0);
  const sloppy = scoreDirection(score({ structuralDistinctiveness: 9, slopRisk: 10 }), 0);
  check('slop penalty outweighs a strong distinctiveness score',
    sloppy.total < high.total - 3, `${sloppy.total} vs ${high.total}`);

  const vetoed = scoreDirection(score(), 2);
  const clean = scoreDirection(score(), 0);
  check('each veto costs 3 points', Math.abs((clean.total - vetoed.total) - 6) < 0.001,
    `${clean.total} - ${vetoed.total}`);
}

{
  const dirs = [
    direction({ name: 'Generic' }),
    direction({ name: 'Bold' }),
    direction({ name: 'Sloppy' }),
  ];
  const scores = [
    score({ name: 'Generic', structuralDistinctiveness: 3 }),
    score({ name: 'Bold', structuralDistinctiveness: 9, evidenceFit: 9, typographicCraft: 9 }),
    score({ name: 'Sloppy', structuralDistinctiveness: 10, slopRisk: 9 }),
  ];
  const verdict = chooseDirection(dirs, scores, snapshot);
  check('rubric picks the strong, non-sloppy direction', verdict.chosen.name === 'Bold',
    `chose ${verdict.chosen.name}; ranking ${verdict.ranking.map((r) => `${r.name}=${r.score}`).join(', ')}`);
  check('ranking includes every direction', verdict.ranking.length === 3);
  check('rationale is non-empty and names the winner', verdict.rationale.includes('Bold'));

  // Determinism: identical inputs must reproduce the identical choice.
  const again = chooseDirection(dirs, scores, snapshot);
  check('choice is deterministic', again.chosen.name === verdict.chosen.name
    && again.chosenScore === verdict.chosenScore);
}

{
  // A direction the critic loved but that code vetoes must be beatable.
  const dirs = [
    direction({ name: 'BadFont', typography: { displayFont: 'Fraunces', bodyFont: 'Outfit', hierarchyRule: 'x', microLabelTreatment: 'y' } }),
    direction({ name: 'GoodFont' }),
  ];
  const scores = [
    score({ name: 'BadFont', structuralDistinctiveness: 10, evidenceFit: 10, typographicCraft: 10, referenceGrounding: 10, motionRestraint: 10 }),
    score({ name: 'GoodFont', structuralDistinctiveness: 7, evidenceFit: 7, typographicCraft: 7, referenceGrounding: 7, motionRestraint: 7 }),
  ];
  const verdict = chooseDirection(dirs, scores, snapshot);
  check('two font vetoes (6.0) sink a perfect-scoring direction', verdict.chosen.name === 'GoodFont',
    `${verdict.ranking.map((r) => `${r.name}=${r.score}(${r.vetoes.length} vetoes)`).join(', ')}`);
}

// ── wow gate: the motion pack (references/motion/README.md) ─────────────────

check('wowTotal sums the six axes', wowTotal(wow()) === 15, `${wowTotal(wow())}`);
check(`the floor is ${WOW_FAIL_THRESHOLD}/${WOW_MAX}`, WOW_FAIL_THRESHOLD === 9 && WOW_MAX === 18);

check('a wow total below the floor fails as a default AI template',
  !wowVerdict(wow({ heroMotion: 1, scrollChoreography: 1, typeAsDesign: 1, photoTreatment: 1, microInteraction: 1, performanceReducedMotion: 1 })).passed);

{
  // heroMotion 0 fails on its own — this is the specific defect Roman rejected,
  // so a page that is otherwise excellent must still not pass.
  const strongButStatic = wow({ heroMotion: 0, scrollChoreography: 3, typeAsDesign: 3, photoTreatment: 3, microInteraction: 3, performanceReducedMotion: 3 });
  const v = wowVerdict(strongButStatic);
  check('heroMotion 0 fails even at 15/18 on the other axes',
    !v.passed && v.total === 15 && v.reasons.some((r) => r.includes('hero motion is 0')), `total ${v.total}`);
}

check('a solid profile passes the gate', wowVerdict(wow()).passed);

{
  // THE REGRESSION TEST FOR THIS WHOLE FEATURE.
  //
  // These are the axes the critic actually gave the deployed Pagoulatos demo —
  // the demo Roman rejected — with the reference stills and motion frames
  // attached (run 2026-08-18, `pnpm tsx scripts/phaseC-critic-check.ts`).
  // It clears the 9/18 total, so the total alone would have PASSED the page
  // Roman rejected. It fails only because `performanceReducedMotion` is excluded
  // from the ambition score, which is precisely why that second condition exists.
  const pagoulatos = {
    heroMotion: 2, scrollChoreography: 1, typeAsDesign: 2,
    photoTreatment: 1, microInteraction: 1, performanceReducedMotion: 3,
  };
  const v = wowVerdict(pagoulatos);
  check('the rejected Pagoulatos demo clears the total floor (10/18)',
    v.total === 10 && v.total >= WOW_FAIL_THRESHOLD, `total ${v.total}`);
  check('...but FAILS on design ambition (7/15), which is the gate that matters',
    !v.passed && v.ambition === 7 && v.reasons.some((r) => r.includes('ambition')),
    `ambition ${v.ambition}, reasons: ${v.reasons.join(' | ')}`);
  check('the failure names the weak axes so the builder knows what to raise',
    v.reasons.some((r) => r.includes('scrollChoreography') && r.includes('photoTreatment')),
    v.reasons.join(' | '));
}

check('a page cannot buy a pass with reduced-motion hygiene alone',
  !wowVerdict({ heroMotion: 2, scrollChoreography: 1, typeAsDesign: 2, photoTreatment: 1, microInteraction: 1, performanceReducedMotion: 3 }).passed);

check('genuinely striking work passes both conditions',
  wowVerdict({ heroMotion: 3, scrollChoreography: 2, typeAsDesign: 2, photoTreatment: 2, microInteraction: 2, performanceReducedMotion: 2 }).passed);

// Vetoes specific to the motion pack.
check('an unknown reference slug is vetoed',
  vetoesFor(direction({ referenceSlug: 'not-a-real-site' }), snapshot, KNOWN_SLUGS)
    .some((v) => v.reason.includes('not in references/motion')));

check('a known slug passes',
  vetoesFor(direction(), snapshot, KNOWN_SLUGS).length === 0);

check('slug checking is skipped when no slugs are supplied',
  vetoesFor(direction({ referenceSlug: 'anything-at-all' }), snapshot).length === 0);

// ── brand palette: the fix for "чого всі демо в одному стилі" ──────────────
//
// The failure these guard against is not a crash: it is a direction that
// SAYS it started from the business's identity and did not. Free-prose
// `derivedFrom` made that unfalsifiable, which is how three salons ended up
// with the same page.

check('a palette echoing the measured brand colours may claim paletteSource "brand"',
  vetoesFor(direction(), snapshot, KNOWN_SLUGS).length === 0);

check('claiming "brand" with colours unrelated to any measured one is vetoed',
  vetoesFor(direction({
    palette: {
      background: '#f0f4ff', foreground: '#101828', accent: '#3b82f6',
      accentUsage: 'buttons', derivedFrom: 'the reference', paletteSource: 'brand',
      brandAlignment: 'took the reference blue',
    },
  }), snapshot, KNOWN_SLUGS).some((v) => v.reason.includes('within reach of any')),
  'a generic blue must not pass as this business\'s terracotta');

check('claiming "brand" when nothing was measured is vetoed',
  vetoesFor(direction(), {
    ...snapshot,
    brand: { ...snapshot.brand, paletteSource: 'none', primary: null, accent: null, logoColors: null },
  }, KNOWN_SLUGS).some((v) => v.reason.includes('no measured brand colours')));

check('a contrast-corrected brand accent still counts as brand-derived',
  vetoesFor(direction({
    palette: {
      background: '#fbf9f6', foreground: '#1a1512', accent: '#8a6a2e',
      accentUsage: 'rules and micro-labels', derivedFrom: 'the logo, corrected for AA',
      paletteSource: 'brand',
      brandAlignment: 'the logo gold #c8a15a darkened to #8a6a2e so body text passes AA',
    },
  }), snapshot, KNOWN_SLUGS).length === 0,
  'correcting a brand colour for contrast is craft, not neglect');

check('ignoring an available brand palette is flagged as neglect, NOT vetoed',
  (() => {
    const generic = direction({
      palette: {
        background: '#ffffff', foreground: '#111111', accent: '#3b82f6',
        accentUsage: 'buttons', derivedFrom: 'the niche', paletteSource: 'photos',
        brandAlignment: 'did not use the logo',
      },
    });
    return brandNeglect(generic, snapshot) !== null
      && vetoesFor(generic, snapshot, KNOWN_SLUGS).length === 0;
  })(),
  'a design judgement must cost points without being called a defect');

check('a business with no measured identity cannot "neglect" one',
  brandNeglect(direction({
    palette: {
      background: '#fff', foreground: '#111', accent: '#3b82f6', accentUsage: 'x',
      derivedFrom: 'the niche', paletteSource: 'reference-fallback', brandAlignment: 'nothing measured',
    },
  }), {
    ...snapshot,
    brand: { ...snapshot.brand, paletteSource: 'none', primary: null, accent: null, logoColors: null },
  }) === null);

check('brand-grounded beats generic when the critic likes them equally',
  (() => {
    const branded = direction({ name: 'Branded' });
    const generic = direction({
      name: 'Generic',
      palette: {
        background: '#ffffff', foreground: '#111111', accent: '#3b82f6',
        accentUsage: 'buttons', derivedFrom: 'the niche', paletteSource: 'photos',
        brandAlignment: 'did not use the logo',
      },
    });
    const verdict = chooseDirection(
      [generic, branded],
      [score({ name: 'Generic' }), score({ name: 'Branded' })],
      snapshot, KNOWN_SLUGS,
    );
    return verdict.chosen.name === 'Branded';
  })(),
  'the neglect penalty must actually change the winner');

check('the rationale records which evidence the palette rests on',
  (() => {
    const v = chooseDirection([direction()], [score()], snapshot, KNOWN_SLUGS);
    return v.rationale.includes('palette source "brand"') && v.rationale.includes('#8a3b2a');
  })());

check('a snapshot frozen before the brand section still ranks',
  (() => {
    const legacy = { ...snapshot } as Record<string, unknown>;
    delete legacy.brand;
    const v = chooseDirection([direction()], [score()], legacy as typeof snapshot, KNOWN_SLUGS);
    return Number.isFinite(v.chosenScore);
  })(),
  'rebuilding an old project must not crash on a key that did not exist then');

check('a missing critic axis scores 0 rather than poisoning the whole sum',
  (() => {
    const partial = score();
    delete (partial as Partial<DirectionScore>).brandFit;
    return Number.isFinite(scoreDirection(partial, 0).total);
  })());

check('heroMotion "none" without a justification is vetoed',
  vetoesFor(direction({ heroMotion: 'none', heroMotionJustification: null }), snapshot, KNOWN_SLUGS)
    .some((v) => v.reason.includes('does not move')));

check('heroMotion "none" WITH a justification is allowed',
  vetoesFor(direction({ heroMotion: 'none', heroMotionJustification: 'the only photo is a 400px logo' }), snapshot, KNOWN_SLUGS)
    .length === 0);

check('heroMotion "video" with no video asset is vetoed',
  vetoesFor(direction({ heroMotion: 'video' }), snapshot, KNOWN_SLUGS)
    .some((v) => v.reason.includes('no video asset')));

check('heroMotion "kenburns" with no real photo is vetoed',
  vetoesFor(direction({ heroMotion: 'kenburns', heroTreatment: { kind: 'typographic', assetFile: null, description: 'type only' } }),
    { ...snapshot, assets: snapshot.assets.filter((a) => a.aiGenerated) }, KNOWN_SLUGS)
    .some((v) => v.reason.includes('no real (non-AI) photo')));

{
  // The gate must have teeth in the ranking, not just in the report: a direction
  // that promises no motion has to lose to one that does, even when the critic
  // scored the static one higher on every other axis.
  const dirs = [
    direction({ name: 'Static', heroMotion: 'none', heroMotionJustification: 'no photos worth animating' }),
    direction({ name: 'Moving' }),
  ];
  const scores = [
    score({
      name: 'Static',
      structuralDistinctiveness: 9, evidenceFit: 9, typographicCraft: 9, referenceGrounding: 9, motionRestraint: 9,
      wow: wow({ heroMotion: 0, scrollChoreography: 1, microInteraction: 1, performanceReducedMotion: 1 }),
    }),
    score({ name: 'Moving', structuralDistinctiveness: 7, evidenceFit: 7, typographicCraft: 7, referenceGrounding: 7, motionRestraint: 7 }),
  ];
  const verdict = chooseDirection(dirs, scores, snapshot, KNOWN_SLUGS);
  check('a static-hero direction loses to a moving one despite better taste scores',
    verdict.chosen.name === 'Moving',
    verdict.ranking.map((r) => `${r.name}=${r.score}(wow ${r.wow.total})`).join(', '));
  check('the verdict carries the winner\'s wow estimate',
    verdict.chosenWow.total === 15 && verdict.chosenWow.passed);
  check('the rationale states the wow score and the reference',
    verdict.rationale.includes(`15/${WOW_MAX}`) && verdict.rationale.includes('vero-studio'));
}

{
  // The wow axis must contribute to the score, not merely gate it: two directions
  // that both clear the floor should still separate on how much wow they promise.
  const dirs = [direction({ name: 'Modest' }), direction({ name: 'Striking' })];
  const scores = [
    score({ name: 'Modest', wow: wow({ heroMotion: 2, scrollChoreography: 1, typeAsDesign: 2, photoTreatment: 2, microInteraction: 1, performanceReducedMotion: 2 }) }),
    score({ name: 'Striking', wow: wow({ heroMotion: 3, scrollChoreography: 3, typeAsDesign: 3, photoTreatment: 3, microInteraction: 3, performanceReducedMotion: 3 }) }),
  ];
  const verdict = chooseDirection(dirs, scores, snapshot, KNOWN_SLUGS);
  check('more wow wins between two otherwise identical directions',
    verdict.chosen.name === 'Striking',
    verdict.ranking.map((r) => `${r.name}=${r.score}(wow ${r.wow.total})`).join(', '));
}

// ── motion pack parsing ─────────────────────────────────────────────────────

{
  const readme = [
    '| Slug | URL | Mood | Top 3 mechanics | Best for |',
    '|---|---|---|---|---|',
    '| **vero-studio** | verostudio.com | Warm editorial | a; b; c | **Hair salon, bridal.** Best match |',
    '| **izanami** | izanami-official.com | Meditative | slow Ken Burns; tiny serif | **Yoga studio, retreat, high-end spa** |',
    '| not-bold | x.com | y | z | w |',
  ].join('\n');
  const parsed = parseMotionIndex(readme);
  check('index parses only the bolded slug rows', parsed.length === 2, `got ${parsed.length}`);
  check('index keeps the slug, mood and mechanics',
    parsed[0]!.slug === 'vero-studio' && parsed[0]!.topMechanics.length === 3
    && parsed[0]!.bestFor.startsWith('Hair salon'));

  const short = shortlistReferences(parsed, { category: 'Yoga studio', name: 'Ananda' }, 1);
  check('the shortlist matches the business category over index order',
    short[0]!.slug === 'izanami', short.map((s) => s.slug).join(','));

  const noMatch = shortlistReferences(parsed, { category: 'Bakery', name: null }, 1);
  check('with no category match the shortlist falls back to index order',
    noMatch[0]!.slug === 'vero-studio');
}

{
  const notes = [
    '# Vero — atelier', '', '- **URL:** https://example.com', '',
    '## What makes the wow', '', '- a percentage preloader', '',
    '## Timing & easing', '', 'slow and confident', '',
    '## Palette', '', 'cream and amber', '',
    '## Reproduce with our stack', '', '- one ScrollTrigger with pin', '',
    "## Don't borrow", '', '- the full preloader as-is', '',
  ].join('\n');
  const condensed = condenseNotes(notes);
  check('condensed notes keep the mechanics sections',
    condensed.includes('percentage preloader') && condensed.includes('ScrollTrigger with pin')
    && condensed.includes('full preloader as-is'));
  check('condensed notes drop the timing and palette prose',
    !condensed.includes('slow and confident') && !condensed.includes('cream and amber'));
  check('condensed notes keep the identifying lead block',
    condensed.includes('# Vero — atelier') && condensed.includes('https://example.com'));
  check('condenseNotes respects its char cap', condenseNotes(notes, 80).length <= 100);
}

{
  // The real pack on disk: every slug the index advertises must be a directory the
  // workspace can copy stills from, or the critic silently loses its bar.
  const { existsSync } = await import('node:fs');
  const { loadMotionIndex, motionRefDir, loadCondensedNotes } = await import('../src/build/motionRefs.js');
  const index = await loadMotionIndex();
  if (index.length === 0) {
    check('motion reference pack present', false, 'references/motion/README.md not found');
  } else {
    check('motion index parses the on-disk pack', index.length >= 15, `${index.length} references`);
    const missing = index.filter((e) => !existsSync(motionRefDir(e.slug)));
    check('every indexed slug has a directory', missing.length === 0,
      missing.map((m) => m.slug).join(', ') || 'all present');
    const noStills = index.filter((e) => !existsSync(`${motionRefDir(e.slug)}/hero.jpg`));
    check('every reference has a hero.jpg for the critic', noStills.length === 0,
      noStills.map((m) => m.slug).join(', ') || 'all present');
    // Prompt budget: five condensed notes ship with every design call, on top of
    // a 14KB niche pack and a 16KB component catalogue.
    const shortlist = shortlistReferences(index, { category: 'Nail salon', name: 'Aigli' });
    let bytes = 0;
    for (const e of shortlist) bytes += (await loadCondensedNotes(e.slug))?.length ?? 0;
    check('shortlisted notes stay within the prompt budget', bytes < 30_000,
      `${shortlist.length} notes, ${bytes} chars`);
  }
}


// ── contact sanity: "verified" does not mean "usable on a demo" ─────────────

for (const [channel, value, shouldDrop, why] of [
  ['phone', '+30 2610 279 118', false, 'real Greek number'],
  ['phone', '261 043 4464', false, 'real number, loosely spaced'],
  ['phone', '1234', true, 'too short to dial'],
  ['phone', '0000000000', true, 'all identical digits'],
  ['email', 'info@salon.gr', false, 'real address'],
  ['email', 'hello@anemi-fixture.example.gr', true, 'RFC 2606 reserved domain'],
  ['email', 'x@test.com', true, 'reserved test domain'],
  ['email', 'noreply@salon.gr', true, 'no-reply is not a contact'],
  ['email', 'not-an-email', true, 'syntactically invalid'],
  ['instagram', 'https://instagram.com/velvet.cosmetic.lounge', false, 'real profile'],
  ['instagram', 'https://instagram.com/_u', true, 'scraping artifact seen in real Patras data'],
  ['instagram', 'https://instagram.com/', true, 'network root, not a profile'],
  ['instagram', 'https://instagram.com/explore', true, 'platform path'],
  ['instagram', '@velvet.lounge', false, 'bare handle is fine'],
  ['website', 'https://www.google.com/url?q=http://salon.gr', true, 'Google redirector'],
  ['website', 'https://salon.gr/', false, 'real site'],
] as Array<[string, string, boolean, string]>) {
  const reason = unusableContactReason(channel, value);
  check(`contact ${shouldDrop ? 'DROPPED' : 'kept'}: ${channel} "${value}" (${why})`,
    (reason !== null) === shouldDrop, reason ?? 'kept');
}

// ── provenance ──────────────────────────────────────────────────────────────

const outDir = await mkdtemp(path.join(tmpdir(), 'phasec-prov-'));

async function html(body: string, opts: { noindex?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(outDir, 'case-'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'),
    `<!doctype html><html lang="el"><head><meta charset="utf-8">` +
    `${opts.noindex === false ? '' : '<meta name="robots" content="noindex, nofollow"/>'}` +
    `<title>Nail Studio Aigli</title></head><body>${body}</body></html>`);
  return dir;
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <img src="/assets/hero-abc.jpg" alt="Το στούντιο"/>`);
  const rep = await checkProvenance(dir, snapshot);
  check('honest page passes provenance', rep.ok, rep.findings.map((f) => f.kind).join(','));
  check('present contact recorded', rep.contactsPresent.length > 0, rep.contactsPresent.join(', '));
}

{
  const dir = await html(`<a href="tel:+302109999999">210 999 9999</a>`);
  const rep = await checkProvenance(dir, snapshot);
  check('invented phone number is caught', !rep.ok && rep.findings.some((f) => f.kind === 'foreign-phone'),
    rep.findings.map((f) => f.detail.slice(0, 60)).join(' | '));
}

{
  // Gallery numbering is not a phone; a bare mobile-shaped run still is.
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <figure>01</figure> <figure>02</figure> <figure>03</figure> <figure>04</figure> <figure>05</figure>`);
  const rep = await checkProvenance(dir, snapshot);
  check('ordinal numbering «01 02 03 04 05» is not a foreign phone', !rep.findings.some((f) => f.kind === 'foreign-phone'),
    rep.findings.map((f) => f.detail.slice(0, 80)).join(' | '));
  const dir2 = await html(`<a href="tel:+302610123456">2610 123456</a> <p>Καλέστε 698 000 1122</p>`);
  const rep2 = await checkProvenance(dir2, snapshot);
  check('a bare invented mobile number is still caught', rep2.findings.some((f) => f.kind === 'foreign-phone'),
    rep2.findings.map((f) => f.detail.slice(0, 80)).join(' | '));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a><p>info@fake-salon.gr</p>`);
  const rep = await checkProvenance(dir, snapshot);
  check('invented email is caught', rep.findings.some((f) => f.kind === 'foreign-email'));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <img src="https://images.unsplash.com/x.jpg" alt="salon"/>`);
  const rep = await checkProvenance(dir, snapshot);
  check('hotlinked stock image is caught', rep.findings.some((f) => f.kind === 'unknown-asset'));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <img src="/assets/not-in-snapshot.jpg" alt="x"/>`);
  const rep = await checkProvenance(dir, snapshot);
  check('unknown local asset is caught', rep.findings.some((f) => f.kind === 'unknown-asset'));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <img src="/generated/background-def.png" alt="Το σαλόνι Nail Studio Aigli"/>`);
  const rep = await checkProvenance(dir, snapshot);
  check('AI image captioned as the real business is caught',
    rep.findings.some((f) => f.kind === 'ai-photo-as-real'));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <img src="/generated/background-def.png" alt=""/>`);
  const rep = await checkProvenance(dir, snapshot);
  check('AI image used decoratively (alt="") passes', rep.ok,
    rep.findings.map((f) => f.kind).join(','));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>`, { noindex: false });
  const rep = await checkProvenance(dir, snapshot);
  check('missing noindex is caught', rep.findings.some((f) => f.kind === 'missing-noindex'));
}

{
  const dir = await html(`<p>Καλώς ήρθατε</p>`);
  const rep = await checkProvenance(dir, snapshot);
  check('page with no contact at all is caught', rep.findings.some((f) => f.kind === 'no-verified-contact'));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <a href="https://instagram.com/nailstudioaigli">Instagram</a>`);
  const rep = await checkProvenance(dir, snapshot);
  check("business's own social link is allowed", rep.ok, rep.findings.map((f) => f.detail).join(' | '));
}

{
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <a href="https://booking-service-we-invented.com/x">Book</a>`);
  const rep = await checkProvenance(dir, snapshot);
  check('invented booking link is flagged', rep.findings.some((f) => f.kind === 'foreign-link'));
}

{
  // Prices and years must not be mistaken for phone numbers.
  const dir = await html(`<a href="tel:+302610123456">2610 123456</a>
    <p>Manicure 15€ · Pedicure 20€ · 2024</p>`);
  const rep = await checkProvenance(dir, snapshot);
  check('prices and years are not flagged as phones', rep.ok,
    rep.findings.map((f) => f.detail.slice(0, 80)).join(' | '));
}

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✅ all phase C unit checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
