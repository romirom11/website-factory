/**
 * Unit tests for the agent-led brand read — no network, no DB, no agent call.
 *
 * What is actually worth testing here is the thing that stands between a model's
 * opinion and a stored fact: `checkGrounding` (is this hex really in that file?)
 * and `sourceIdForFile` (which capture proves it?). Everything else in
 * `brandAgent.ts` is I/O around those two.
 *
 * The palettes are hand-written rather than decoded from fixture images: the
 * question under test is the comparison, and a synthetic palette states the
 * expected answer in the test instead of trusting median cut to reproduce it.
 * (`scripts/test-brand-identity.ts` already covers median cut against a fixture
 * image whose true palette is known by construction.)
 */
import {
  GROUNDING_TOLERANCE_RGB, checkGrounding, renderInputsMd, rgbDistance, sourceIdForFile,
  type BrandInput, type FileColors,
} from '../src/enrichment/brandGrounding.js';
import { fromHex } from '../src/enrichment/colorExtract.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A palette entry in the shape `paletteFromImage` returns. */
function entry(hex: string, share = 0.2) {
  return { hex, share, hsl: { h: 0, s: 0, l: 0 } };
}

// A logo with a gold accent on a near-black field, and a photograph of a warm
// room — the two files a Patras salon actually has.
const FILES: FileColors[] = [
  { file: 'logo.png', palette: [entry('#101014', 0.62), entry('#c8a15a', 0.24), entry('#f7f4ee', 0.14)] },
  { file: 'photo-1.jpg', palette: [entry('#8a7563', 0.4), entry('#d9cfc2', 0.35), entry('#3b2f26', 0.25)] },
  { file: 'instagram-profile.png', palette: [entry('#ffffff', 0.7), entry('#262626', 0.3)] },
  { file: 'broken.png', palette: [] },
];

const INPUTS: BrandInput[] = [
  { file: 'logo.png', what: 'the logo', sourceId: 11, bucket: 'assets', objectKey: 'b/logo.png', contentType: 'image/png' },
  { file: 'photo-1.jpg', what: 'a photo', sourceId: 22, bucket: 'assets', objectKey: 'b/p1.jpg', contentType: 'image/jpeg' },
  { file: 'instagram-profile.png', what: 'the IG profile', sourceId: 33, bucket: 'raw', objectKey: 'e/ig', contentType: 'image/png' },
];

function main(): void {
  // ── 1. the happy path: a colour that is really in the cited file ─────────
  {
    const v = checkGrounding({ hex: '#c8a15a', file: 'logo.png' }, FILES);
    check('an exact logo colour grounds', v.grounded, JSON.stringify(v));
    eq('and reports itself as the nearest colour', v.nearestHex, '#c8a15a');
    eq('at zero distance', v.distance, 0);
    eq('with no reason to record', v.reason, null);
  }

  // ── 2. a near miss inside tolerance ──────────────────────────────────────
  //
  // This is the ORDINARY case, not an edge case: the agent reads a colour by eye
  // off a rendered image while the check re-derives it from median-cut
  // centroids, and those two never agree to the byte. A test that only covered
  // exact matches would pass while the feature rejected every honest answer.
  {
    const v = checkGrounding({ hex: '#cba75f', file: 'logo.png' }, FILES);
    const d = rgbDistance(fromHex('#cba75f')!, fromHex('#c8a15a')!);
    check('a hex a few units off the real one still grounds', v.grounded, JSON.stringify(v));
    check('and the distance is well inside tolerance', d < GROUNDING_TOLERANCE_RGB, `d=${d}`);
  }

  // ── 3. an invented colour, cited against a real file ─────────────────────
  //
  // The failure this whole module exists to catch: a plausible, tasteful palette
  // that has nothing to do with the business's material.
  {
    const v = checkGrounding({ hex: '#1e88e5', file: 'logo.png' }, FILES);
    check('a colour that is not in the logo is rejected', !v.grounded, JSON.stringify(v));
    // The reason has to be checkable by a person reading a note, so it names
    // the nearest colour that IS in the file and the bar it missed. (Nearest
    // here is the gold, not the near-black field: this blue is closer to a
    // saturated mid-tone than to #101014, which is exactly why the message
    // reports the distance rather than leaving the reader to guess.)
    check('and the reason names the nearest real colour and the tolerance',
      !!v.reason?.includes(v.nearestHex ?? 'x') && !!v.reason?.includes(String(GROUNDING_TOLERANCE_RGB)),
      String(v.reason));
    check('the nearest colour is one really in the file',
      FILES[0]!.palette.some((c) => c.hex === v.nearestHex), String(v.nearestHex));
  }

  // ── 4. the right colour cited against the WRONG file ─────────────────────
  //
  // Subtle and worth its own case: the gold IS the brand's, but claiming it came
  // off a photograph of a room means the citation proves nothing, and the
  // source_id we would store would point at the wrong capture.
  {
    const v = checkGrounding({ hex: '#c8a15a', file: 'photo-1.jpg' }, FILES);
    check('a real brand colour cited against a file it is not in is rejected',
      !v.grounded, JSON.stringify(v));
  }

  // ── 5. a citation naming no file at all ──────────────────────────────────
  {
    const v = checkGrounding({ hex: '#c8a15a', file: 'the logo' }, FILES);
    check('an unknown filename is rejected', !v.grounded, JSON.stringify(v));
    check('and says so rather than reporting a distance',
      !!v.reason?.includes('not a file in the workspace') && v.distance === null, String(v.reason));
  }

  // ── 6. path forms the agent actually writes ──────────────────────────────
  //
  // Models cite `./logo.png` and `/tmp/factory-brand-xxx/logo.png` about as
  // often as the bare name. Rejecting those would drop grounded colours over
  // punctuation, which is the worst kind of false negative: it looks like the
  // agent invented a colour when it did not.
  {
    for (const cited of ['./logo.png', 'LOGO.PNG', '  logo.png  ', '/tmp/factory-brand-a1/logo.png']) {
      const v = checkGrounding({ hex: '#c8a15a', file: cited }, FILES);
      check(`"${cited}" resolves to logo.png`, v.grounded, JSON.stringify(v));
    }
  }

  // ── 7. malformed hexes ───────────────────────────────────────────────────
  {
    for (const bad of ['gold', '#12345', 'rgb(200,161,90)', '']) {
      const v = checkGrounding({ hex: bad, file: 'logo.png' }, FILES);
      check(`"${bad}" is rejected as a non-hex`, !v.grounded && !!v.reason?.includes('not a hex'),
        JSON.stringify(v));
    }
    // Three-digit hex IS valid CSS and `fromHex` expands it; the check must not
    // reject a colour for being written short.
    const short = checkGrounding({ hex: '#fff', file: 'instagram-profile.png' }, FILES);
    check('a 3-digit hex expands and grounds', short.grounded, JSON.stringify(short));
  }

  // ── 8. a file that yielded no colours ────────────────────────────────────
  //
  // An undecodable image is not evidence the agent lied — but it is also not
  // evidence the colour is real, so the colour is dropped and the note says
  // which of the two happened.
  {
    const v = checkGrounding({ hex: '#c8a15a', file: 'broken.png' }, FILES);
    check('a file with an empty palette grounds nothing', !v.grounded, JSON.stringify(v));
    check('and the reason distinguishes "undecodable" from "invented"',
      !!v.reason?.includes('no colours to compare'), String(v.reason));
  }

  // ── 9. the tolerance boundary, from both sides ───────────────────────────
  //
  // Pinned deliberately: this number is the whole contract between the agent and
  // the evidence rules, and a silent change to it would silently change which
  // palettes ship.
  {
    const base = fromHex('#808080')!;
    const files: FileColors[] = [{ file: 'g.png', palette: [entry('#808080', 1)] }];
    // Pure-red offsets, so the distance IS the offset.
    const inside = `#${(base.r + 59).toString(16)}8080`;
    const outside = `#${(base.r + 61).toString(16)}8080`;
    check('59 units away grounds', checkGrounding({ hex: inside, file: 'g.png' }, files).grounded, inside);
    check('61 units away does not', !checkGrounding({ hex: outside, file: 'g.png' }, files).grounded, outside);
    // An explicit tolerance must be honoured — the deterministic cross-check
    // may want a stricter one than the design contract's.
    check('a stricter explicit tolerance rejects what the default accepts',
      !checkGrounding({ hex: inside, file: 'g.png' }, files, 10).grounded, inside);
  }

  // ── 10. INPUTS.md mapping: filename -> source_id ─────────────────────────
  {
    eq('logo.png maps to its capture', sourceIdForFile('logo.png', INPUTS), 11);
    eq('photo-1.jpg maps to the listing capture', sourceIdForFile('photo-1.jpg', INPUTS), 22);
    eq('the IG screenshot maps to the profile capture', sourceIdForFile('instagram-profile.png', INPUTS), 33);
    eq('a path-prefixed citation still maps', sourceIdForFile('./logo.png', INPUTS), 11);
    eq('case does not matter', sourceIdForFile('Photo-1.JPG', INPUTS), 22);
    // The invariant: no source, no fact. A filename nobody was shown must
    // return null rather than defaulting to the first input.
    eq('an unknown file has no source id', sourceIdForFile('hero.png', INPUTS), null);
    eq('an empty citation has no source id', sourceIdForFile('', INPUTS), null);
  }

  // ── 11. INPUTS.md itself ─────────────────────────────────────────────────
  //
  // It is the agent's only map of the workspace, so a file missing from it is a
  // file the agent cannot legally cite.
  {
    const md = renderInputsMd('Exte Hair Design', INPUTS);
    check('every input appears in INPUTS.md',
      INPUTS.every((i) => md.includes(`\`${i.file}\``)), md.slice(0, 200));
    check('the business name is in the heading', md.includes('Exte Hair Design'), md.slice(0, 80));
    check('the grounding rule is stated to the agent',
      /re-derives every hex/i.test(md), md.slice(-200));
    // Source ids stay OUT of the prompt: the agent cites filenames, and code
    // owns the filename -> source_id mapping. Putting ids in front of the model
    // would invite it to quote one it never derived anything from.
    check('no source_id leaks into the prompt',
      !/source_?id/i.test(md), md);
  }

  // ── 12. an empty workspace ───────────────────────────────────────────────
  //
  // Nothing to look at is the fallback trigger, and it must not throw on the way
  // to returning null.
  {
    const v = checkGrounding({ hex: '#c8a15a', file: 'logo.png' }, []);
    check('grounding against no files rejects rather than throwing', !v.grounded, JSON.stringify(v));
    eq('and no source id can be found either', sourceIdForFile('logo.png', []), null);
    const md = renderInputsMd('Nobody', []);
    check('INPUTS.md for an empty workspace is still valid markdown', md.includes('# Brand material'), md);
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
}

main();
