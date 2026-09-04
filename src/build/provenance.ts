/**
 * Provenance enforcement — code, not trust (SPEC §4 stage 10, CLAUDE.md invariant
 * "Вигадувати контакти/послуги/відгуки/ціни неможливо by construction").
 *
 * The builder agent is instructed to use only snapshot facts. This module VERIFIES
 * that instead of believing it: it parses the exported HTML and checks every
 * contact-shaped string (phone, email, external URL) against the snapshot. Anything
 * the snapshot does not contain is a QA issue that goes straight back to the agent.
 *
 * Deliberately narrow: it detects *fabricated contact details and unmarked AI
 * media*, which are the failures that would embarrass Roman in front of a business
 * owner. Prose claims ("award-winning") are the visual critic's job — a regex
 * cannot judge those, and pretending it can produces false confidence.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BuildSnapshot } from './snapshot.js';

export interface ProvenanceFinding {
  severity: 'high' | 'medium';
  kind: 'foreign-phone' | 'foreign-email' | 'foreign-link' | 'missing-noindex'
    | 'no-verified-contact' | 'unknown-asset' | 'ai-photo-as-real';
  detail: string;
  file: string;
}

export interface ProvenanceReport {
  ok: boolean;
  findings: ProvenanceFinding[];
  checkedFiles: string[];
  /** Contacts from the snapshot that actually appear on the site. */
  contactsPresent: string[];
}

/** Hosts a demo may legitimately link to without it being a fabricated business link. */
const NEUTRAL_HOSTS = [
  'schema.org', 'www.w3.org', 'fonts.googleapis.com', 'fonts.gstatic.com',
  'localhost', '127.0.0.1',
];

/** Digits only — how a phone number is compared regardless of formatting. */
function digits(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * A rendered phone can be spaced/dashed arbitrarily, so compare suffixes of the
 * digit strings: a real Greek number is 10 digits, +30 prefixed makes 12.
 */
function phoneMatches(candidate: string, known: string[]): boolean {
  const c = digits(candidate);
  if (c.length < 8) return false; // too short to be a phone; likely a price or date
  return known.some((k) => {
    const kd = digits(k);
    if (kd.length < 8) return false;
    // The greedy run regex can swallow neighbouring digits together with the
    // number (a year, a gallery ordinal: «2610 123456 01 02»); a candidate that
    // CONTAINS the known number's last nine digits is that number plus noise,
    // not a fabricated one — so containment, not an exact suffix.
    return c.includes(kd.slice(-9)) || kd.includes(c.slice(-9));
  });
}

async function collectHtmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (e.name === '_next' || e.name === 'node_modules') continue;
        await walk(full);
      } else if (e.name.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

/** Strip tags so we test what a reader sees, plus keep href/src values separately. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * Check a built static export against the snapshot it was built from.
 * `outDir` is the Next.js `out/` directory.
 */
export async function checkProvenance(outDir: string, snapshot: BuildSnapshot): Promise<ProvenanceReport> {
  const files = await collectHtmlFiles(outDir);
  const findings: ProvenanceFinding[] = [];
  const contactsPresent = new Set<string>();

  const knownPhones = snapshot.contacts
    .filter((c) => ['phone', 'whatsapp', 'viber'].includes(c.channel))
    .map((c) => c.value);
  const knownEmails = snapshot.contacts
    .filter((c) => c.channel === 'email')
    .map((c) => c.value.toLowerCase());
  // Links the business genuinely owns: its site, its socials, its booking links.
  const knownHosts = new Set<string>();
  for (const url of [
    snapshot.website.url,
    ...Object.values(snapshot.socials),
    ...snapshot.contacts.filter((c) => /^https?:/i.test(c.value)).map((c) => c.value),
  ]) {
    if (!url) continue;
    try { knownHosts.add(new URL(url).host.replace(/^www\./, '')); } catch { /* not a URL */ }
  }
  const knownAssetFiles = new Set(snapshot.assets.map((a) => path.basename(a.file)));
  const aiAssetFiles = new Set(snapshot.assets.filter((a) => a.aiGenerated).map((a) => path.basename(a.file)));

  let sawNoindex = false;

  for (const file of files) {
    const rel = path.relative(outDir, file);
    const html = await readFile(file, 'utf8');
    const text = visibleText(html);

    if (/name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) sawNoindex = true;

    // ── phones ──────────────────────────────────────────────────────────────
    // tel: hrefs are unambiguous contact claims; check them strictly.
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      const value = m[1]!;
      if (phoneMatches(value, knownPhones)) {
        contactsPresent.add(`tel:${value}`);
      } else {
        findings.push({
          severity: 'high', kind: 'foreign-phone', file: rel,
          detail: `tel: link "${value}" is not any phone in the snapshot (known: ${knownPhones.join(', ') || 'none'})`,
        });
      }
    }
    // Visible phone-shaped runs. Greek numbers: +30 followed by 10 digits, or a
    // bare 10-digit number starting 2 (landline) or 6 (mobile), optionally spaced
    // in groups. A bare run that starts with anything else is not a number a
    // reader could dial here — the gallery numbering «01 02 03 04 05» was flagged
    // as a fabricated phone in three QA rounds (BEAUTIFY Laser, 2026-09-04).
    for (const m of text.matchAll(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g)) {
      const candidate = m[0]!;
      const d = digits(candidate);
      if (d.length < 9 || d.length > 15) continue; // prices, years, dates
      if (!candidate.trim().startsWith('+') && !/^[26]/.test(d)) continue; // ordinals, ids, not a Greek phone
      if (phoneMatches(candidate, knownPhones)) {
        contactsPresent.add(candidate.trim());
      } else {
        findings.push({
          severity: 'high', kind: 'foreign-phone', file: rel,
          detail: `visible phone-shaped text "${candidate.trim()}" does not match any snapshot phone (known: ${knownPhones.join(', ') || 'none'})`,
        });
      }
    }

    // ── emails ──────────────────────────────────────────────────────────────
    for (const m of html.matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)) {
      const value = m[0]!.toLowerCase();
      if (value.endsWith('.png') || value.endsWith('.jpg')) continue;
      if (knownEmails.includes(value)) {
        contactsPresent.add(value);
      } else {
        findings.push({
          severity: 'high', kind: 'foreign-email', file: rel,
          detail: `email "${value}" is not in the snapshot contacts (known: ${knownEmails.join(', ') || 'none'})`,
        });
      }
    }

    // ── external links ──────────────────────────────────────────────────────
    for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
      const url = m[1]!;
      let host: string;
      try { host = new URL(url).host.replace(/^www\./, ''); } catch { continue; }
      if (NEUTRAL_HOSTS.includes(host) || knownHosts.has(host)) continue;
      findings.push({
        severity: 'medium', kind: 'foreign-link', file: rel,
        detail: `external link to "${host}" (${url.slice(0, 120)}) is not the business's own site or social profile`,
      });
    }

    // ── images ──────────────────────────────────────────────────────────────
    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
      const tag = m[0]!;
      const src = m[1]!;
      if (src.startsWith('data:')) continue;
      const base = path.basename(src.split('?')[0]!);
      if (!src.startsWith('/assets/') && !src.startsWith('/generated/')) {
        findings.push({
          severity: 'high', kind: 'unknown-asset', file: rel,
          detail: `<img src="${src}"> is outside /assets/ and /generated/ — only snapshot assets may be shown`,
        });
        continue;
      }
      if (!knownAssetFiles.has(base)) {
        findings.push({
          severity: 'high', kind: 'unknown-asset', file: rel,
          detail: `<img src="${src}"> references a file that is not a snapshot asset`,
        });
      }
      // An AI image is decorative. If the alt text claims it depicts this business,
      // that is exactly the invariant CLAUDE.md forbids.
      if (aiAssetFiles.has(base)) {
        const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
        const claimsReality = alt.trim().length > 0
          && new RegExp(snapshot.name.split(/\s+/)[0] ?? ' ', 'i').test(alt);
        if (claimsReality) {
          findings.push({
            severity: 'high', kind: 'ai-photo-as-real', file: rel,
            detail: `AI-generated image "${base}" has alt text naming the business ("${alt}") — it may only be decorative`,
          });
        }
      }
    }
  }

  if (!sawNoindex) {
    findings.push({
      severity: 'high', kind: 'missing-noindex', file: 'index.html',
      detail: 'no <meta name="robots" content="noindex"> found; demos are private (SPEC §8)',
    });
  }

  // The whole point of the demo is a working call-to-action.
  const verifiedValues = snapshot.contacts.filter((c) => c.verified).map((c) => c.value);
  const anyContactShown = contactsPresent.size > 0;
  if (!anyContactShown) {
    findings.push({
      severity: 'high', kind: 'no-verified-contact', file: 'index.html',
      detail: `no snapshot contact appears anywhere on the site (expected one of: ${(verifiedValues.length ? verifiedValues : snapshot.contacts.map((c) => c.value)).join(', ') || 'none available'})`,
    });
  }

  // Deduplicate: the same fabricated number repeated in header and footer is one issue.
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.kind}:${f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ok: deduped.every((f) => f.severity !== 'high'),
    findings: deduped,
    checkedFiles: files.map((f) => path.relative(outDir, f)),
    contactsPresent: [...contactsPresent],
  };
}
