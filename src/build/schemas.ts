/**
 * Zod contracts for stage 9 (content brief + design) and stage 10 (build result).
 *
 * These are the only channel between an LLM and the pipeline: every agent output
 * is validated here, and an output that never validates becomes NEEDS_HUMAN rather
 * than a silently-degraded default (SPEC §7).
 */
import { z } from 'zod';
import { HERO_MOTION_KINDS, WOW_AXES } from './motionRefs.js';

// ─── Stage 9a: content brief ────────────────────────────────────────────────

/**
 * A claim the site is allowed to make, tied to the snapshot path it came from.
 * `sourceIds` are `business_sources.id` values copied out of the snapshot — the
 * agent cannot invent them because it only ever sees the ids the snapshot lists.
 */
export const AllowedClaimSchema = z.object({
  claim: z.string().min(1),
  /** Dotted path into snapshot.json, e.g. `services[2].value.name`. */
  snapshotPath: z.string().min(1),
  sourceIds: z.array(z.number()),
});

export const BriefSectionSchema = z.object({
  id: z.string().min(1),
  /** Section name in the site language. */
  name: z.string().min(1),
  purpose: z.string().min(1),
  /** What content goes in, expressed only as references to snapshot facts. */
  contentSummary: z.string().min(1),
  /** Snapshot fields this section renders. Empty = the section is pure typography. */
  usesSnapshotPaths: z.array(z.string()),
  priority: z.number().int().min(1).max(10),
});

export const ContentBriefSchema = z.object({
  language: z.string().min(2),
  /** One sentence, in the site language, that could not describe any other business. */
  businessOneLiner: z.string().min(1),
  mainOffer: z.string().min(1),
  primaryCta: z.object({
    label: z.string().min(1),
    /** Must be a real contact from the snapshot: tel:/ mailto:/ https:// */
    href: z.string().min(1),
    rationale: z.string(),
  }),
  toneOfVoice: z.string().min(1),
  sections: z.array(BriefSectionSchema).min(3).max(9),
  allowedClaims: z.array(AllowedClaimSchema),
  /** Things a generic copywriter would write that this snapshot does NOT support. */
  forbiddenClaims: z.array(z.string()),
  /** Honest consequences of missing evidence, e.g. "no reviews -> no reviews section". */
  omissions: z.array(z.string()),
  copyConstraints: z.object({
    maxHeadlineWords: z.number().int().min(2).max(20),
    maxParagraphSentences: z.number().int().min(1).max(6),
    bannedPhrases: z.array(z.string()),
  }),
});
export type ContentBrief = z.infer<typeof ContentBriefSchema>;

// ─── Stage 9b: art directions ───────────────────────────────────────────────

/**
 * Fonts verified to carry the `greek` subset. A miss is a HARD next/font build
 * error ("Unknown subset `greek` for font X"), not a silent fallback, so this
 * list is a build-safety constraint, not a style preference.
 *
 * Verified against `next/dist/compiled/@next/font/dist/google/font-data.json`
 * in the template's installed Next 15 (2026-08-16), which is the same manifest
 * that decides whether the build passes. Re-check with
 * `pnpm tsx scripts/phaseC-fonts.ts` after a Next upgrade.
 *
 * Deliberately excluded despite being obvious display choices: **Cormorant**,
 * **Cormorant Garamond** and **Playfair Display** ship NO greek subset. They
 * read as safe editorial serifs and were wrong in an earlier version of this
 * list; the builder agent caught it and substituted, but the rubric must not
 * hand it a poisoned pick in the first place.
 *
 * `italic` matters: an art direction that sets a roman/italic couplet cannot be
 * built with GFS_Didot, which is single-weight roman only.
 */
export const GREEK_SAFE_DISPLAY = [
  'EB_Garamond',        // 400-800 + true italic — the strongest general-purpose pick
  'Literata',           // variable + italic
  'Noto_Serif_Display', // variable + italic
  'Alegreya',           // variable + italic, calligraphic
  'Gentium_Book_Plus',  // 400/700 + italic
  'GFS_Didot',          // Greek-designed Didone; 400 only, NO italic
] as const;

/** Greek-capable body faces (all variable-weight unless noted). */
export const GREEK_SAFE_BODY = [
  'Manrope',        // no italic
  'Source_Sans_3',
  'IBM_Plex_Sans',
  'Inter_Tight',
  'Noto_Sans',
  'Open_Sans',
  'Roboto',
] as const;

/** Display faces that lack `greek` and would fail the build if requested with it. */
export const GREEK_UNSAFE_NOTE =
  'Cormorant, Cormorant Garamond, Playfair Display, Fraunces, Outfit, Instrument Serif, ' +
  'Marcellus and Jost have NO greek subset — they fail the build.';

export const ArtDirectionSchema = z.object({
  name: z.string().min(1),
  /** One line naming what makes this direction structurally different from the others. */
  bigIdea: z.string().min(1),
  /**
   * The ONE element this page will be remembered by — what it is, which section
   * it lives in, and why it belongs to THIS business's world. The direction's
   * boldness is spent here; everything around it stays quiet and disciplined.
   * A page whose signature could be deleted without anyone noticing has none —
   * that is the "default AI template" failure in one sentence.
   */
  signature: z.string().min(1).describe(
    'The single element this page is remembered by: what it is, which section, why it is native to this business.',
  ),
  /**
   * The choreography CONTRACT (MOTION-PLAN phase 1). A motion site is one
   * orchestrated sequence, not sprinkled effects — this map is what turns
   * «3-4 mechanic labels» into something the builder can implement scene by
   * scene and the critic can verdict scene by scene. Kept to one line per
   * field on purpose: large structured outputs die on the runtime's turn cap.
   */
  sceneMap: z.object({
    system: z.string().min(1).describe(
      'ONE line: the easing family, the duration scale, and what unifies every motion on the page (e.g. "power2.out everywhere, 0.6/0.9/1.2s scale, everything enters from the reading direction").',
    ),
    scenes: z.array(z.object({
      section: z.string().min(1).describe('sectionId from the layout skeleton'),
      trigger: z.enum(['load', 'enter', 'scrub', 'pin']).describe(
        'load = page-load timeline; enter = fires once when scrolled into view; scrub = tied to scroll progress; pin = section pins while its content plays',
      ),
      motion: z.string().min(1).describe('ONE line: which elements transform and how'),
      handoff: z.string().min(1).describe('ONE line: how this section visually passes to the next'),
    })).min(3).max(8).describe('One entry per layout section that moves. A section absent here is deliberately static.'),
  }).describe('The page choreography as a verifiable contract; the critic verdicts every scene from motion frames.'),
  /**
   * The image-to-video prompt for the hero wow-clip, written BY THE ART
   * DIRECTOR because only the direction knows what video it needs (Roman,
   * 2026-08-22: «Звідки воно знає, яке відео треба для дизайну?» — про
   * generic-бриф, який це поле замінює). Roman pastes it into a generator and
   * uploads the mp4 from the business card.
   */
  heroVideoBrief: z.string().min(60).nullable().describe(
    'The full i2v prompt for an external generator, in English: 8s landscape, start frame = a real photo YOU HAVE '
    + 'SEEN (attached to this call), camera/light/pace that SERVE this direction\'s mood and hero treatment, and '
    + 'the standing rule that nothing in the frame may be added, removed or morphed. Describe only what is actually '
    + 'in the chosen photo. null ONLY when the snapshot has no real photograph.',
  ),
  /**
   * The exact snapshot asset the brief's start frame is: the UI links THIS
   * file next to the prompt. The first shipped brief described an imagined
   * photo («forearm skin with handpiece») while the panel offered a different
   * file — a vertical text banner (Roman, 2026-08-22: «І шо це за брєд?»).
   * Code vetoes a file that is not a real (non-AI) snapshot photo.
   */
  heroVideoStartFrame: z.string().min(1).nullable().describe(
    'The snapshot asset file the brief starts from, exactly as listed in the asset inventory. '
    + 'Must be a real (non-AI) photograph you have seen. null only when heroVideoBrief is null.',
  ),
  /** Ordered layout skeleton — section ids from the brief plus their composition. */
  layoutSkeleton: z.array(z.object({
    sectionId: z.string().min(1),
    composition: z.string().min(1),
    /** Deliberate rhythm: sections must not all be the same height. */
    heightFeel: z.enum(['tall', 'medium', 'tight', 'full-bleed']),
  })).min(3),
  typography: z.object({
    displayFont: z.string().min(1),
    bodyFont: z.string().min(1),
    /** Explicit statement of how hierarchy is made — size contrast, not weight soup. */
    hierarchyRule: z.string().min(1),
    microLabelTreatment: z.string().min(1),
  }),
  palette: z.object({
    background: z.string().min(1),
    foreground: z.string().min(1),
    /** ONE accent. The ban-list treats 3+ accents as slop. */
    accent: z.string().min(1),
    accentUsage: z.string().min(1),
    /** Where the colours came from: a real photo, a logo, or the niche. */
    derivedFrom: z.string().min(1),
    /**
     * WHICH EVIDENCE the palette rests on, as a claim code can check.
     *
     * Roman's rejection of the first batch was that every demo looked the same;
     * the cause was that `derivedFrom` was free prose, so "derived from the warm
     * tones of the photographs" was equally sayable whether or not the direction
     * had looked at a single measured colour. This field is the checkable half:
     * `brand` asserts the palette starts from `snapshot.brand`, and
     * `vetoesFor()` penalises claiming it when the hexes do not match.
     *
     * `reference-fallback` is honest and allowed — a business with no logo, no
     * site colours and no usable avatar genuinely has no palette to inherit —
     * but it costs points when brand evidence WAS available.
     */
    paletteSource: z.enum(['brand', 'photos', 'reference-fallback']),
    /**
     * How this palette relates to the business's measured identity: which brand
     * hex each role came from, or why none was usable. One or two sentences.
     */
    brandAlignment: z.string().min(1),
  }),
  motionConcept: z.object({
    idea: z.string().min(1),
    techniques: z.array(z.string()).min(1).max(4),
    reducedMotionPlan: z.string().min(1),
  }),
  heroTreatment: z.object({
    kind: z.enum(['real-photo-full-bleed', 'real-photo-split', 'real-photo-macro-crop', 'typographic', 'photo-grid']),
    assetFile: z.string().nullable(),
    description: z.string().min(1),
  }),
  /** Components from `components/README.md` this direction actually uses (max 4). */
  poolComponents: z.array(z.string()).max(4),
  /** Exactly one reference from references/<niche>/README.md, by its heading name. */
  reference: z.object({
    name: z.string().min(1),
    borrowedMechanics: z.array(z.string()).min(1),
  }),

  // ─── Motion pack (references/motion) ──────────────────────────────────────
  /**
   * Slug of the ONE motion reference this direction takes its mood from, e.g.
   * `vero-studio`. Verified against the on-disk index by `vetoesFor()`: a slug
   * that is not a directory under `references/motion/` is a hard veto, so the
   * workspace can copy the reference stills with confidence.
   */
  referenceSlug: z.string().min(1),
  /**
   * 3-4 concrete mechanics lifted from that reference's `notes.md`, each mapped
   * to the component that implements it and the section it lands in. More than
   * four is a showreel, not a business page (motion README rule 3).
   */
  mechanics: z.array(z.object({
    /** The mechanic as the reference's notes name it, e.g. "vertical split-screen wipe". */
    name: z.string().min(1),
    /** Template component (motion pack or pool) or `css`/`gsap` for hand-written work. */
    component: z.string().min(1),
    /** Which section of the layout skeleton it applies to. */
    where: z.string().min(1),
  })).min(3).max(4),
  /**
   * What makes the FIRST screen move. `none` is permitted only with a stated
   * justification; the rubric scores it 0 on the hero-motion axis and the visual
   * critic fails a static hero outright.
   */
  heroMotion: z.enum(HERO_MOTION_KINDS),
  /** Required when `heroMotion === 'none'`; ignored otherwise. */
  heroMotionJustification: z.string().nullable(),
  /** Typographic load screen, hard-capped at ~1.2s and skipped under reduced motion. */
  preloader: z.boolean(),
  /**
   * How type itself does design work — display size, ratio to body, a cropped
   * wordmark, roman/italic mixing. One sentence; the wow rubric scores it.
   */
  typeAsDesign: z.string().min(1),
  /** Named photo-grade class applied to every photo, or null when there are none. */
  photoGrade: z.string().nullable(),

  /**
   * URLs of any landing.gallery references that actually shaped this direction
   * (`src/lib/landingGallery.ts`). Optional and unverified by code: these are a
   * SECONDARY inspiration source, so a citation is a provenance note for a human
   * reading the design contract months later, not a contract the rubric scores.
   * Unlike `referenceSlug` — which the motion pack must contain — an empty list
   * here is the normal, honest answer.
   */
  galleryRefs: z.array(z.string()).max(8).optional(),
});
export type ArtDirection = z.infer<typeof ArtDirectionSchema>;

export const ArtDirectionsSchema = z.object({
  directions: z.array(ArtDirectionSchema).length(3),
});

// ─── The wow rubric, shared by stage 9 and stage 11 ─────────────────────────

/**
 * The six 0-3 axes from `references/motion/README.md`, built from `WOW_AXES` so
 * the schema, the prompt text and the gate can never drift apart. Stage 9 scores
 * them as an ESTIMATE from a written direction; stage 11 scores them from
 * screenshots and motion frames of the built page. Same axes, same floor.
 */
export const WowScoresSchema = z.object(
  // Rounded, not rejected: these are 0-3 buckets, and a critic answering `2.5`
  // is expressing "between solid and striking", not producing garbage. Failing
  // the whole critique over it costs a full retry of a heavy multimodal session
  // — which is exactly what a stray 5.5 on `closeness` cost on the first run.
  Object.fromEntries(WOW_AXES.map((a) => [
    a.key,
    z.number().min(0).max(3).transform((n) => Math.round(n)),
  ])) as {
    [K in (typeof WOW_AXES)[number]['key']]: z.ZodEffects<z.ZodNumber, number, number>
  },
);
export type WowScores = z.infer<typeof WowScoresSchema>;

// ─── Stage 9c: critique that feeds the code-side rubric ─────────────────────

/**
 * The critic scores; CODE decides. Every field is a 0-10 integer with a stated
 * reason so a low score is auditable, and the winner is computed by
 * `scoreDirection()` in rubric.ts — the model never picks.
 */
export const DirectionScoreSchema = z.object({
  name: z.string().min(1),
  /** Structural distance from a generic template layout. */
  structuralDistinctiveness: z.number().int().min(0).max(10),
  /** Fit to THIS business's evidence: does the hero plan match the real photos? */
  evidenceFit: z.number().int().min(0).max(10),
  /** Typographic ambition: size contrast, micro-labels, restraint. */
  typographicCraft: z.number().int().min(0).max(10),
  /** How concretely the named reference is borrowed from. */
  referenceGrounding: z.number().int().min(0).max(10),
  /**
   * Does the palette actually start from the business's OWN measured identity
   * (`snapshot.brand`), and does it differ from the other demos in this
   * campaign? A direction that ignores an available brand palette, or repeats a
   * palette already deployed for a neighbouring business, scores low here.
   * When the snapshot carries no brand evidence at all, this axis scores the
   * honesty of `reference-fallback` instead.
   */
  brandFit: z.number().int().min(0).max(10),
  /** Motion that reveals content rather than decorating. */
  motionRestraint: z.number().int().min(0).max(10),
  /** Ban-list tells present. Higher = MORE slop. Subtracted by the rubric. */
  slopRisk: z.number().int().min(0).max(10),
  /** Risk this direction cannot be built from the pool in a static export. */
  buildRisk: z.number().int().min(0).max(10),
  /**
   * Estimated wow, 0-3 per axis, judged from what the direction PROMISES. A
   * direction that never states a mechanic cannot score for it. Total below
   * 9/18, or heroMotion 0, loses to any direction that clears the floor.
   */
  wow: WowScoresSchema,
  detectedSlopTells: z.array(z.string()),
  reasoning: z.string().min(1),
});
export type DirectionScore = z.infer<typeof DirectionScoreSchema>;

export const DirectionCritiqueSchema = z.object({
  scores: z.array(DirectionScoreSchema).length(3),
});

// ─── Stage 10: build result ─────────────────────────────────────────────────

export const BuildResultSchema = z.object({
  ok: z.boolean(),
  /** Route paths produced, e.g. ["/"]. */
  pages: z.array(z.string()),
  notes: z.string(),
  /** Asset files actually referenced by the built site. */
  usedAssets: z.array(z.string()),
  /** Brief/design requirements the agent could NOT satisfy, said out loud. */
  unresolved: z.array(z.string()),
  /**
   * What the agent SAW in the reference images and took from them, per file.
   * Required and non-trivial on purpose: the first shipped demo was built
   * without a single reference image ever being opened (measured from the
   * build log, 2026-08-22 — zero `references/` reads across the whole run),
   * and the design read as a template. A field the agent must fill per image
   * is the cheapest mechanism that makes it actually look.
   */
  referenceNotes: z.string().min(80).describe(
    'Per reference image you opened (Read): file name + 1-2 sentences on what you took from it. '
    + 'You must actually open them; do not summarise their notes.md instead.',
  ),
  /**
   * The self-screenshot pass: what `_shots/desktop.png` / `_shots/mobile.png`
   * showed and what was changed because of it. «пропустив цей крок» is a
   * legitimate value ONLY when `pnpm shot` itself failed — say so and why.
   */
  selfReview: z.string().min(40).describe(
    'What your own screenshots (_shots/*.png after `pnpm shot`) showed and what you changed '
    + 'because of it. If `pnpm shot` itself failed, say so and why instead.',
  ),
});
export type BuildResult = z.infer<typeof BuildResultSchema>;

// ─── Stage 11: visual critique ──────────────────────────────────────────────

export const QaIssueSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  /** Which axis of the §2.4 rubric this violates. `wow` is the motion-pack gate. */
  category: z.enum([
    'typographic-hierarchy', 'spacing-rhythm', 'photo-treatment',
    'motion-appropriateness', 'slop', 'layout', 'contrast', 'content', 'wow',
  ]),
  /**
   * Where the problem was measured. The critic emits one name
   * (mobile/tablet/desktop/all); the QA worker's dedupe pass may merge
   * identical findings into "desktop+mobile" so one broken headline seen on
   * three screens reads as ONE issue, not three. Free string on purpose.
   */
  viewport: z.string().min(1),
  issue: z.string().min(1),
  /** Concrete instruction the builder can act on. Not "make it better". */
  fix: z.string().min(1),
});
export type QaIssue = z.infer<typeof QaIssueSchema>;

export const VisualCritiqueSchema = z.object({
  approved: z.boolean(),
  /**
   * 0-10 on each rubric axis of SPEC §2.4, for the QA report.
   *
   * Rounded rather than rejected, for the same reason as `closeness` and the wow
   * axes below: a critic that answers `6.5` has judged the page perfectly well,
   * and burning a whole ~$1 / 5-minute retry over the decimal buys nothing. Seen
   * for real on iteration 1 of the M.K Hair Studio build, where the run came back
   * `spacingRhythm: 6.5` and the strict `.int()` threw the entire critique away.
   */
  rubric: z.object({
    typographicHierarchy: z.number().min(0).max(10).transform((n) => Math.round(n)),
    spacingRhythm: z.number().min(0).max(10).transform((n) => Math.round(n)),
    photoTreatment: z.number().min(0).max(10).transform((n) => Math.round(n)),
    motionAppropriateness: z.number().min(0).max(10).transform((n) => Math.round(n)),
  }),
  /**
   * The six 0-3 wow axes, judged from the screenshots AND the motion frames
   * (t=0 / t≈0.8s / t≈1.6s plus six scroll positions). Code, not the critic,
   * applies the gate: total < 9/18 or heroMotion 0 fails as "default AI template".
   */
  wow: WowScoresSchema,
  /**
   * Direct comparison against the chosen motion reference's own stills, which are
   * supplied alongside the demo screenshots. `gap` names what the reference does
   * that this page does not — the actionable half.
   */
  referenceComparison: z.object({
    slug: z.string(),
    /**
     * 0-10: how close this page gets to the reference's level of craft.
     *
     * Rounded rather than rejected. The critic answered `5.5` on the first real
     * run, which failed an `.int()` constraint and cost a full retry — ten
     * minutes and a second heavy session — over half a point on a number that is
     * reported, never compared against a threshold. Half-points are a reasonable
     * thing for a critic to say; throwing the whole critique away for one is not.
     */
    closeness: z.number().min(0).max(10).transform((n) => Math.round(n)),
    gap: z.string().min(1),
  }),
  issues: z.array(QaIssueSchema),
  /** What the page genuinely does well — keeps fix iterations from destroying it. */
  strengths: z.array(z.string()),
  /**
   * The contract check (MOTION-PLAN phase 4): one verdict per promised mechanic
   * / scene, judged from the motion frames. Code turns every `absent` into a
   * high-severity wow issue — a promised mechanic nobody can SEE is the
   * «default AI template» failure with a name attached.
   */
  mechanicVerdicts: z.array(z.object({
    name: z.string().min(1).describe('the mechanic or scene, exactly as the contract names it'),
    verdict: z.enum(['implemented', 'partial', 'absent', 'unobservable'])
      .describe('unobservable = the frames cannot show it (cursor-driven), so no verdict is possible'),
    evidence: z.string().min(1).describe('which frame(s) show it, or why nothing does'),
  })).describe('One entry per mechanic and per sceneMap scene supplied in the payload; empty only if none were supplied.'),
});
export type VisualCritique = z.infer<typeof VisualCritiqueSchema>;

/**
 * Version of the frozen design-contract document (`sites/<biz>/design`).
 * Compatibility policy (Roman, 2026-08-22): NO field-level fallbacks for old
 * contracts — a build that meets an older version regenerates the design from
 * scratch under the current schema. Bump on every breaking contract change.
 * v2: sceneMap + heroVideoBrief + signature became required.
 * v3: heroVideoStartFrame added; heroVideoBrief grounded in photos the art
 *     director actually SAW (both nullable only when no real photo exists).
 */
export const DESIGN_CONTRACT_VERSION = 3;
