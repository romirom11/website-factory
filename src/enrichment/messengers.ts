/**
 * Messenger + social detection (spec §4 stage 4: "окремо детектяться месенджери
 * бізнесу: WhatsApp/Viber-маркери біля телефону, Instagram/Facebook профілі").
 *
 * Deterministic and evidence-bound: every hit records the exact marker snippet
 * it came from, so a contact row can always be traced back to captured HTML.
 * Nothing here guesses — a phone number is NOT assumed to be on WhatsApp just
 * because it exists; there must be a wa.me/api.whatsapp.com link, a viber://
 * link, or the literal word next to a number.
 */

export type ContactChannel =
  | 'whatsapp' | 'viber' | 'instagram' | 'facebook' | 'tiktok'
  | 'telegram' | 'phone' | 'email' | 'website' | 'contact_form';

export interface DetectedContact {
  channel: ContactChannel;
  /** Normalized value: a phone in digits for messengers, a profile URL for socials. */
  value: string;
  /** Verbatim marker from the captured evidence that proves this detection. */
  evidence: string;
}

const MAX_EVIDENCE = 200;

function snippet(haystack: string, index: number, len = 90): string {
  const start = Math.max(0, index - len);
  return haystack.slice(start, index + len).replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE);
}

/** Keeps a leading + and digits; used so wa.me/306912345678 and +30 691 234 5678 unify. */
export function normalizeMsisdn(raw: string): string | null {
  const cleaned = raw.replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return cleaned.startsWith('+') ? `+${digits}` : digits;
}

function push(out: DetectedContact[], c: DetectedContact): void {
  const dupe = out.some((e) => e.channel === c.channel && e.value.toLowerCase() === c.value.toLowerCase());
  if (!dupe) out.push(c);
}

/**
 * Sub-pages of a profile that are not the profile. The Instagram app's «share
 * profile» link is `instagram.com/<handle>/profilecard/?igsh=…`, and owners
 * paste exactly that into their Google listing — one reached a contact as
 * `…/mc_laser_patras/profilecard` (2026-09-25). Facebook pages carry their
 * own tabs (`/about`, `/reviews`, `/posts`).
 */
const PROFILE_SUBPAGES = new Set([
  'profilecard', 'reels', 'tagged', 'saved', 'followers', 'following', 'channel', 'guides', 'igtv',
  'about', 'about_details', 'posts', 'reviews', 'photos', 'videos', 'events', 'community', 'services', 'mentions', 'timeline',
]);

/** Strips tracking noise and profile sub-pages so two links to the same profile dedupe. */
export function cleanProfileUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
    let segments = u.pathname.split('/').filter(Boolean);
    if (/(^|\.)(instagram|facebook|tiktok)\.com$/.test(host) && segments.length > 1) {
      // A plain profile is one segment; keep the handle and drop the sub-page.
      // Special roots (`_u/<handle>`, `people/<name>/<id>`, `profile.php`) keep
      // their shape — the deny-lists below decide what they are.
      const first = segments[0]!.toLowerCase();
      if (!IG_PATH_DENY.has(first) && !FB_PATH_DENY.has(first) && !FB_VERSION_SEGMENT.test(first) && first !== 'people') {
        segments = segments.filter((segment, index) => index === 0 || !PROFILE_SUBPAGES.has(segment.toLowerCase()));
        segments = segments.slice(0, 1);
      }
    }
    const path = segments.length ? `/${segments.join('/')}` : '';
    return `${u.protocol}//${host}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const IG_PATH_DENY = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'directory', 'about', 'developer', 'legal', 'privacy', '_u', '_n', 'share']);
/**
 * Instagram deep links carry the real handle in a query parameter
 * (`instagram.com/_u/<handle>`), so the path segment is a placeholder. The QA
 * agent flagged `https://instagram.com/_u` reaching contacts on the real run,
 * from a truncated meta tag. A handle also has to look like a handle: a bare
 * run of underscores or a single character is a parsing artefact.
 */
function isPlausibleHandle(handle: string): boolean {
  if (handle.length < 3) return false;
  if (!/[a-z0-9]/i.test(handle)) return false;       // must contain something real
  if (/^[._]+$/.test(handle)) return false;
  return true;
}
const FB_PATH_DENY = new Set(['sharer', 'sharer.php', 'share', 'plugins', 'tr', 'dialog', 'login', 'help', 'policies', 'privacy', 'legal', 'events', 'groups', 'photo.php', 'watch', 'connect', 'sdk', 'sdk.js', 'signup', 'terms']);
/**
 * Facebook JS-SDK endpoints are versioned (`/v2.5/plugins/like.php`,
 * `/v18.0/dialog/...`). The version segment comes first, so the deny-list above
 * never sees the real path — observed leaking `facebook.com/v2.5/plugins` into
 * contacts on the real run.
 */
const FB_VERSION_SEGMENT = /^v\d+(?:\.\d+)?$/i;

/**
 * Handles/pages belonging to the PLATFORM rather than to any business on it.
 *
 * Flagged by the QA agent on the real run: capturing a Treatwell profile
 * harvested Treatwell's own Instagram and Facebook icons as the salon's
 * "verified" contact channels, and a Facebook page capture turned Facebook's
 * login form into the business's contact form. Both are present-and-wrong data,
 * which is worse than a gap — it would misdirect outreach.
 */
const PLATFORM_HANDLES = new Set([
  'treatwell', 'treatwellgr', 'booksy', 'fresha', 'easyrantevou', 'linktree', 'linktr',
  'instagram', 'facebook', 'meta', 'whatsapp', 'tiktok', 'youtube', 'google', 'wix', 'wordpress',
  'shopify', 'squarespace', 'godaddy', 'weebly', 'webflow', 'yelp', 'tripadvisor', 'foursquare',
]);

/** Facebook/Instagram chrome that is never a business's own contact affordance. */
const PLATFORM_PATH_MARKERS = /\/(recover|login|checkpoint|help|settings|privacy|policies|terms|cookie|account|signup|business|ads|marketplace|gaming|watch|photos|followers|following|friends)(\/|$|\?)/i;

function isPlatformOwned(url: string): boolean {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const handle = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0].replace(/^@/, '').toLowerCase();
    if (PLATFORM_HANDLES.has(handle)) return true;
    if (PLATFORM_PATH_MARKERS.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Scans raw HTML/text for messenger and social markers.
 * `text` should be the captured page source (links live in href attributes).
 *
 * @param opts.sourceType kind of page this HTML came from. On a third-party page
 *   (a directory listing, or the business's profile ON a social network) the
 *   platform's own links and forms are NOT the business's contacts, so only
 *   markers that carry an explicit identifier (a phone number in a wa.me link)
 *   are trusted. On the business's own website every marker is fair game.
 */
export function detectContacts(
  text: string,
  opts: { sourceType?: string; knownProfiles?: string[] } = {},
): DetectedContact[] {
  const out: DetectedContact[] = [];
  if (!text) return out;
  // A page we do not control the chrome of: its own nav/footer/login belongs to
  // the platform, not to the business whose profile we happen to be reading.
  const thirdParty = opts.sourceType !== undefined && opts.sourceType !== 'owned_website';
  // Profiles already known to be the business's own (the URL we navigated to,
  // plus anything the Maps listing published). On a third-party page these are
  // the ONLY social links that can be attributed to the business.
  const ownProfiles = new Set((opts.knownProfiles ?? []).map((u) => cleanProfileUrl(u)));

  // ── WhatsApp: click-to-chat links carry the number ─────────────────────────
  // The number may be percent-encoded (`phone=%2B30691...`), exactly as Viber's
  // is below, so `%2B` is accepted where a literal `+` would be and decoded
  // before normalizing. Without this the click-to-chat link — the ONLY
  // trustworthy WhatsApp marker — was missed and detection fell through to the
  // weaker "word near a number" rule.
  const waLink = /(?:https?:\/\/)?(?:api\.whatsapp\.com\/send\?[^"'\s<>]*phone=|wa\.me\/|whatsapp:\/\/send\?[^"'\s<>]*phone=)((?:%2B|\+)?\d[\d\s\-()]{6,20})/gi;
  for (const m of text.matchAll(waLink)) {
    let decoded = m[1];
    try { decoded = decodeURIComponent(m[1]); } catch { /* keep raw */ }
    const msisdn = normalizeMsisdn(decoded);
    if (msisdn) push(out, { channel: 'whatsapp', value: msisdn, evidence: snippet(text, m.index ?? 0) });
  }

  // ── Viber: viber://chat?number= / viber://add?number= ──────────────────────
  // the number may be percent-encoded (%2B for a leading +), so decode BEFORE normalizing
  const viberLink = /viber:\/\/(?:chat|add|contact)\?[^"'\s<>]*number=((?:%2B|\+)?[\d\s\-()%]{6,26})/gi;
  for (const m of text.matchAll(viberLink)) {
    let decoded = m[1];
    try { decoded = decodeURIComponent(m[1]); } catch { /* keep raw */ }
    const msisdn = normalizeMsisdn(decoded);
    if (msisdn) push(out, { channel: 'viber', value: msisdn, evidence: snippet(text, m.index ?? 0) });
  }

  // ── Word markers next to a phone number ───────────────────────────────────
  // "WhatsApp: +30 691 ..." / "+30 691 ... (Viber)". The number must be within
  // ~60 chars of the word, otherwise it is not "biля телефону" and we skip it.
  const phoneRe = /\+?\d[\d\s\-().]{7,19}\d/g;
  for (const word of [['whatsapp', 'whatsapp'], ['viber', 'viber'], ['βάιμπερ', 'viber'], ['ουατσαπ', 'whatsapp']] as const) {
    // The marker must be a standalone WORD addressed to a human, not a fragment
    // of an identifier. Facebook's page bundle embeds keys like
    // `"whatsapp_ad_context":null` and `whatsappNumber`, and the nearby
    // `&id=100063552791835` (the page's own numeric id) then normalized into a
    // plausible-looking MSISDN — a fabricated WhatsApp contact for a business
    // that has none. Requiring a non-identifier character on both sides removes
    // the whole class without weakening the real "WhatsApp: +30 691…" case.
    const wordRe = new RegExp(`(^|[^a-zA-Z0-9_-])${word[0]}([^a-zA-Z0-9_-]|$)`, 'gi');
    for (const wm of text.matchAll(wordRe)) {
      const at = wm.index ?? 0;
      const window = text.slice(Math.max(0, at - 60), at + 60 + word[0].length);
      // A run of digits with no separators and no country code is an id, not a
      // dialable number: real Greek numbers are written with spaces/dashes or a
      // +30 prefix. This is the second half of the same defence.
      for (const pm of window.matchAll(phoneRe)) {
        if (/^\d{11,}$/.test(pm[0])) continue;
        const msisdn = normalizeMsisdn(pm[0]);
        if (msisdn) push(out, { channel: word[1] as ContactChannel, value: msisdn, evidence: snippet(text, at) });
      }
    }
  }

  // ── Instagram / Facebook / TikTok / Telegram profiles ─────────────────────
  const ig = /https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9._]{2,40})/gi;
  for (const m of text.matchAll(ig)) {
    const handle = m[1].toLowerCase();
    if (IG_PATH_DENY.has(handle) || !isPlausibleHandle(handle)) continue;
    const url = cleanProfileUrl(m[0]);
    if (isPlatformOwned(url)) continue;                 // e.g. instagram.com/treatwell
    if (thirdParty && !ownProfiles.has(url)) continue;  // platform chrome, not the business
    push(out, { channel: 'instagram', value: url, evidence: snippet(text, m.index ?? 0) });
  }
  const fb = /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9._%-]{2,60}(?:\/[A-Za-z0-9._%-]+)?)/gi;
  for (const m of text.matchAll(fb)) {
    const segments = m[1].split('/');
    // skip a leading API-version segment so the real path is what gets judged
    const first = (FB_VERSION_SEGMENT.test(segments[0]) ? segments[1] ?? '' : segments[0]).toLowerCase();
    if (!first || FB_PATH_DENY.has(first) || first.endsWith('.php')) continue;
    // a percent-encoded page slug is a share/tracking artefact, not a profile
    if (/%[0-9a-f]{2}/i.test(first)) continue;
    const url = cleanProfileUrl(m[0]);
    if (isPlatformOwned(url)) continue;
    if (thirdParty && !ownProfiles.has(url)) continue;
    push(out, { channel: 'facebook', value: url, evidence: snippet(text, m.index ?? 0) });
  }
  const tt = /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,40})/gi;
  for (const m of text.matchAll(tt)) {
    if (!isPlausibleHandle(m[1].toLowerCase())) continue;
    const url = cleanProfileUrl(m[0]);
    if (isPlatformOwned(url) || (thirdParty && !ownProfiles.has(url))) continue;
    push(out, { channel: 'tiktok', value: url, evidence: snippet(text, m.index ?? 0) });
  }
  const tg = /https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,40})/gi;
  for (const m of text.matchAll(tg)) {
    const url = cleanProfileUrl(m[0]);
    if (isPlatformOwned(url) || (thirdParty && !ownProfiles.has(url))) continue;
    push(out, { channel: 'telegram', value: url, evidence: snippet(text, m.index ?? 0) });
  }

  // ── mailto: (a real link, not a regex guess at scattered text) ────────────
  const mail = /mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
  for (const m of text.matchAll(mail)) {
    push(out, { channel: 'email', value: m[1].toLowerCase(), evidence: snippet(text, m.index ?? 0) });
  }
  // plain-text emails on the page. On a third-party page these are almost always
  // the platform's own support/legal addresses, so they are not collected there.
  const plainMail = thirdParty ? /(?!)/g : /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
  for (const m of text.matchAll(plainMail)) {
    const v = m[1].toLowerCase();
    // skip asset filenames and obvious placeholders
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(v)) continue;
    if (/^(example|test|your|email|name|user|youremail|someone)@/.test(v)) continue;
    // placeholder / vendor telemetry domains, never a business's real address
    if (/@(example|test|domain|yourdomain|email|sentry|localhost)\.(com|org|net|gr|io)$/i.test(v)) continue;
    if (/(sentry|wixpress|godaddy|\.wix\.com|cloudflare|schema\.org)/i.test(v)) continue;
    push(out, { channel: 'email', value: v, evidence: snippet(text, m.index ?? 0) });
  }

  // ── tel: links ────────────────────────────────────────────────────────────
  const tel = /tel:(\+?[\d\s\-().]{7,22})/gi;
  for (const m of text.matchAll(tel)) {
    const msisdn = normalizeMsisdn(m[1]);
    if (msisdn) push(out, { channel: 'phone', value: msisdn, evidence: snippet(text, m.index ?? 0) });
  }

  // ── contact form ─────────────────────────────────────────────────────────
  // Only on the business's OWN site: a form on Facebook is Facebook's login,
  // and on a directory it is the directory's booking widget.
  if (!thirdParty
    && /<form[^>]*>[\s\S]{0,4000}?(type=["']email["']|name=["'][^"']*(email|mail|message|μήνυμα)[^"']*["'])/i.test(text)) {
    const at = text.search(/<form/i);
    push(out, { channel: 'contact_form', value: 'form_on_site', evidence: snippet(text, at < 0 ? 0 : at) });
  }

  return out;
}

/**
 * Social profile URLs the business itself published (from the maps `website`
 * field or a captured page). Used to decide which pages are worth capturing.
 */
export function classifySocialUrl(url: string): ContactChannel | null {
  try {
    const host = new URL(url).hostname.replace(/^www\.|^m\./, '').toLowerCase();
    if (host.endsWith('instagram.com')) return 'instagram';
    if (host.endsWith('facebook.com') || host.endsWith('fb.com')) return 'facebook';
    if (host.endsWith('tiktok.com')) return 'tiktok';
    if (host === 't.me' || host === 'telegram.me') return 'telegram';
    return null;
  } catch {
    return null;
  }
}
