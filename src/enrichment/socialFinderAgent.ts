/**
 * Agent-led social candidate finder — a searcher that is not on our IP.
 *
 * WHY THIS EXISTS. `socialDiscovery.ts` drives Brave/Startpage/Bing/DuckDuckGo
 * through Playwright from the factory's own machine. On Roman's laptop that
 * works; on the SERVER it does not — those engines answer 429/403 to datacenter
 * IPs, every query is dropped, and the business ends with zero candidates and a
 * `socials_unresolved` gap. Meanwhile a person typing the same words into Google
 * finds the profile in one try: `@laser_royal_patras`, whose bio carries the
 * listing's own phone (2610 272921) and address (Κανακάρη 169Α).
 *
 * The fix is to move the SEARCH — and only the search — off our egress. Claude's
 * built-in WebSearch tool is executed by Anthropic's infrastructure, so its
 * results do not depend on what our server's IP is allowed to fetch. Measured on
 * 2026-08-21 (see the note below): WebSearch returned `@laser_royal_patras` as
 * its first result, while WebFetch — which runs from OUR host — was served a
 * DuckDuckGo CAPTCHA from the very same session. That asymmetry is the whole
 * point of this module, and it is why the agent gets WebSearch and NOT WebFetch:
 * a WebFetch fallback would reintroduce exactly the block we are escaping, at
 * agent prices.
 *
 * WHAT THE AGENT DECIDES: nothing. It returns URLs it believes belong to the
 * business, plus the snippet text that made it think so. Those are LEADS. Every
 * one of them then goes through the unchanged pipeline — capture the profile
 * page as immutable evidence, score it in `socialMatch.ts` against the phone,
 * address, domain and name from the DB — and it is that deterministic code, on
 * the profile's OWN captured page, that decides verified / candidate / discard
 * (SPEC §5: "LLM ніколи не вирішує"). `signalsSeen` below is a hint for the log
 * and nothing else: a phone the agent claims to have read in a bio is never
 * treated as a match signal, because the matcher re-reads the bio itself.
 *
 * So the failure mode of a hallucinating agent is bounded: it can waste a
 * profile capture, it cannot invent a contact.
 */
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { runCodeAgent, z } from '../agents/codeAgent.js';
import { createAgentInputWorkspace } from '../agents/transport.js';
import { isRateLimitedError } from '../agents/types.js';
import { log } from '../lib/logger.js';
import { config } from '../config.js';
import { parseProfileUrl, type SocialCandidate, type SocialTargetBusiness } from './socialDiscovery.js';

// ── the contract with the agent ─────────────────────────────────────────────

const FinderCandidateSchema = z.object({
  /** instagram | facebook | tiktok. Anything else is dropped by the parser. */
  platform: z.string(),
  /** Full profile URL as it appeared in the search results. */
  url: z.string(),
  /** The agent's own 0-1 belief. Ordering hint only; never a verdict. */
  confidence: z.number().min(0).max(1),
  /** One sentence: which query surfaced it and what in the result matched. */
  why: z.string(),
  /**
   * What the agent SAW in the search snippets, verbatim. Not trusted — code
   * re-reads the profile page — but it makes a wrong lead diagnosable.
   */
  signalsSeen: z.object({
    phone: z.string().nullable(),
    address: z.string().nullable(),
    nameMatch: z.string().nullable(),
  }),
});

export const SocialFinderResultSchema = z.object({
  candidates: z.array(FinderCandidateSchema).max(12),
  /** Queries tried, dead ends, ambiguity — anything worth having in the log. */
  notes: z.array(z.string()).max(10),
});

export type SocialFinderResult = z.infer<typeof SocialFinderResultSchema>;

const FINDER_SYSTEM_PROMPT = `You are finding the social media profiles of ONE specific local business, the way a
careful person would: search, read the results, and keep only what plausibly belongs to THIS
business at THIS address.

TOOL. You have WebSearch and nothing else that reaches the network. Use it repeatedly — a single
query is almost never enough. Do NOT try to fetch pages; you cannot, and you do not need to.

HOW TO SEARCH. The business is Greek, so its name may be written in Greek or in Latin letters, and
its own profile may use either. Vary the query:
  - the name plus the city plus "instagram" / "facebook";
  - the name in the other alphabet (transliterate it yourself);
  - the phone number on its own — a business that puts its phone in its Instagram bio is findable
    by that phone, and this is the single strongest query available to you;
  - the street address plus the city;
  - the shortest distinctive part of the name (drop generic trade words like "beauty", "studio",
    "hair", "κομμωτήριο") plus the city.

WHAT COUNTS AS A CANDIDATE. A profile page URL: instagram.com/<handle>, facebook.com/<page> or
facebook.com/p/<Page-Name-123456>, tiktok.com/@<handle>. NEVER a post or reel
(instagram.com/p/..., /reel/...), never a hashtag or explore page, never a directory listing
(Treatwell, Booksy, Yelp, Facebook search results), never the platform's own pages.

DO NOT VERIFY, AND DO NOT PRETEND TO. You cannot open these pages, so you cannot confirm anything.
Code will capture every URL you return and check it against the business's real phone, address and
name. Your job is RECALL: return the plausible ones and let the check do the deciding. A candidate
that turns out wrong costs one page load; a candidate you withheld because you were unsure is a
business with no outreach channel.

Report only what you actually saw. In \`signalsSeen\`, quote the phone / address / name text from
the SEARCH RESULT SNIPPET, verbatim, or null if it was not there. Never write a phone number that
was not in a snippet — it will be checked against the real page and a fabricated one just makes
the log lie. \`confidence\` is your own belief, and low confidence is a fine, useful answer.

If the searches genuinely turn up nothing for this business, return an empty candidates array and
say what you tried in \`notes\`. That is a correct answer, not a failure.`;

/** The brief the agent reads: everything known about the business, and nothing else. */
export function renderFinderBrief(biz: SocialTargetBusiness, known: string[]): string {
  const rows: Array<[string, string | null | undefined]> = [
    ['Name (as listed)', biz.name],
    ['City', biz.city],
    ['Address', biz.address],
    ['Phone', biz.phone],
    ['Category', biz.category],
    ['Website', biz.websiteUrl ?? biz.domain],
  ];
  return [
    `# Find the social profiles of: ${biz.name}`,
    '',
    'This is the business, exactly as it appears in the Google Maps listing:',
    '',
    ...rows.filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    known.length
      ? `Already known (do NOT return these again, look for the OTHER platforms):\n${known.map((k) => `- ${k}`).join('\n')}`
      : 'No profile is known yet for this business.',
    '',
    'Search with WebSearch, then write result.json. Remember: leads, not verdicts.',
  ].join('\n');
}

// ── running it ──────────────────────────────────────────────────────────────

export interface SocialFinderOptions {
  /** Profile URLs the business already has, so the agent does not re-find them. */
  knownProfiles?: string[];
  /** Cap on candidates kept after parsing. Defaults to the setting. */
  maxCandidates?: number;
  timeoutMs?: number;
  /** Injected by the test: skip the real agent and parse this result instead. */
  resultOverride?: SocialFinderResult;
}

export interface SocialFinderOutcome {
  /** Parsed, canonicalised, deduplicated — ready to merge with the engine list. */
  candidates: SocialCandidate[];
  /** Everything the agent said, plus every URL we dropped and why. */
  notes: string[];
  /** Raw agent output, for the evidence record. */
  raw: SocialFinderResult | null;
}

/**
 * Turns the agent's answer into pipeline candidates.
 *
 * Every URL goes through `parseProfileUrl` — the SAME parser the SERP path uses.
 * That is deliberate: it is what rejects posts, reels, directory listings and
 * the platforms' own pages, so the agent cannot widen the accepted shape of a
 * candidate by returning something creative. A URL the parser rejects is dropped
 * with a note rather than silently, because "the agent kept suggesting Treatwell"
 * is something Roman should be able to read in a log.
 *
 * Pure: no I/O, no agent. `scripts/test-social-finder.ts` covers it directly.
 */
export function parseFinderCandidates(
  result: SocialFinderResult,
  opts: { maxCandidates: number; skipPlatforms?: readonly string[] } ,
): { candidates: SocialCandidate[]; notes: string[] } {
  const notes: string[] = [];
  const skip = new Set(opts.skipPlatforms ?? []);
  const byKey = new Map<string, SocialCandidate>();

  // Highest self-reported confidence first: when the cap bites, spend the page
  // loads on the leads the agent was most sure of.
  const ordered = [...result.candidates].sort((a, b) => b.confidence - a.confidence);

  for (const c of ordered) {
    const parsed = parseProfileUrl(c.url.trim());
    if (!parsed) {
      notes.push(`agent candidate rejected (not a profile URL): ${c.url.slice(0, 120)}`);
      continue;
    }
    // The agent's own `platform` label is not authoritative — the URL is. A
    // mismatch is worth recording, but the parsed platform wins.
    if (c.platform && c.platform.toLowerCase() !== parsed.platform) {
      notes.push(`agent said ${c.platform} but the URL is ${parsed.platform}: ${parsed.url}`);
    }
    if (skip.has(parsed.platform)) continue;

    const key = parsed.identity ?? parsed.url;
    const existing = byKey.get(key);
    const via = `agent(${c.confidence.toFixed(2)})`;
    if (existing) {
      if (!existing.foundVia.includes(via)) existing.foundVia.push(via);
      continue;
    }
    if (byKey.size >= opts.maxCandidates) {
      notes.push(`agent candidate over the cap (${opts.maxCandidates}), dropped: ${parsed.url}`);
      continue;
    }
    parsed.foundVia.push(via);
    byKey.set(key, parsed);
  }

  return { candidates: [...byKey.values()], notes };
}

/**
 * Runs the finder for one business.
 *
 * Never throws. An agent failure, a rate limit, a refusal — all of them return
 * an empty candidate list with a note, because this is an ADDITIONAL source of
 * leads: `discoverSocials` still has whatever the engines found, and a business
 * with no candidates at all was already handled (`socials_unresolved`).
 */
export async function findSocialCandidates(
  biz: SocialTargetBusiness,
  opts: SocialFinderOptions = {},
): Promise<SocialFinderOutcome> {
  const maxCandidates = opts.maxCandidates ?? config.socialDiscovery.finderMaxCandidates;

  if (opts.resultOverride) {
    const { candidates, notes } = parseFinderCandidates(opts.resultOverride, { maxCandidates });
    return { candidates, notes: [...opts.resultOverride.notes, ...notes], raw: opts.resultOverride };
  }

  const dir = await createAgentInputWorkspace('factory-social-');
  try {
    await writeFile(path.join(dir, 'BRIEF.md'), renderFinderBrief(biz, opts.knownProfiles ?? []));

    let result: SocialFinderResult;
    try {
      result = await runCodeAgent({
        name: 'social-finder',
        cwd: dir,
        prompt: `Read BRIEF.md in this workspace, then find the social media profiles of the business it describes.\n\n`
          + 'Use WebSearch several times with different query shapes before you answer.',
        appendSystemPrompt: FINDER_SYSTEM_PROMPT,
        // Sonnet tier: this is search + reading snippets, not design work.
        heavy: false,
        kind: 'enrichment',
        // One turn per search, plus room to read the brief and write result.json.
        maxTurns: 20,
        timeoutMs: opts.timeoutMs ?? 8 * 60_000,
        // WebSearch is executed by Anthropic, not by us — that is the entire
        // reason this module exists. WebFetch is deliberately ABSENT: measured
        // 2026-08-21, it runs from OUR egress (it reported this host's own
        // public IP and was served a DuckDuckGo CAPTCHA), so it would inherit
        // the very blocks the agent is here to bypass.
        //
        // ToolSearch is required, not optional: the SDK defers WebSearch and the
        // agent must look its schema up before it can call it. Without it the
        // agent silently has no way to search at all (verified empirically).
        allowedTools: ['ToolSearch', 'WebSearch', 'Read', 'Write'],
        // Headless even when builds run in tmux: a few minutes of searching in a
        // scratch dir is nothing anyone would attach to. The runner reserves
        // its single web-terminal slot for attachable build sessions.
        terminal: false,
        onUsage: (u) => log.info('agent usage', { businessId: biz.id, call: 'social-finder', ...u }),
      }, SocialFinderResultSchema);
    } catch (err) {
      // A rate limit is NOT a finder failure — it is "the subscription window is
      // closed, come back later" (SPEC §2.3б). Swallowing it here would turn a
      // job the queue knows how to requeue into a permanent `socials_unresolved`
      // gap for a business whose profile is perfectly findable.
      if (isRateLimitedError(err)) throw err;
      log.warn('social finder agent failed; continuing with engine candidates only', {
        businessId: biz.id, err: String(err).slice(0, 300),
      });
      return { candidates: [], notes: [`agent finder failed: ${String(err).slice(0, 200)}`], raw: null };
    }

    const { candidates, notes } = parseFinderCandidates(result, { maxCandidates });
    log.info('social finder agent done', {
      businessId: biz.id,
      returned: result.candidates.length,
      kept: candidates.length,
      urls: candidates.map((c) => c.url),
    });
    return { candidates, notes: [...result.notes, ...notes], raw: result };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
