/** Presentation helpers shared by the pages. No business logic here. */

export const BUSINESS_STATUSES = [
  'discovered', 'prequalified', 'enriching', 'needs_review', 'qualified',
  'production_ready', 'site_in_progress', 'site_ready', 'outreach_approved',
  'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost',
  'rejected', 'duplicate', 'closed', 'do_not_contact',
] as const;

export const DEAL_STATES = ['contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'] as const;

/** Colour role per status: green = progress, amber = waiting on a human, red = dead. */
export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'info' | 'idle' {
  if (['won', 'production_ready', 'site_ready', 'replied'].includes(status)) return 'ok';
  if (['needs_review', 'outreach_approved'].includes(status)) return 'warn';
  if (['rejected', 'lost', 'do_not_contact', 'duplicate', 'closed'].includes(status)) return 'bad';
  if (['contacted', 'meeting', 'proposal', 'qualified'].includes(status)) return 'info';
  return 'idle';
}

export function jobTone(status: string): 'ok' | 'warn' | 'bad' | 'info' | 'idle' {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'needs_human') return 'warn';
  // A reconciler-closed ghost job is over and done with, not an error to chase.
  if (status === 'stale') return 'idle';
  if (status === 'skipped') return 'idle';
  // retry_wait is a subscription pause, NOT an error (SPEC §2.3б).
  if (status === 'retry_wait') return 'info';
  if (status === 'running') return 'info';
  return 'idle';
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Time of day, formatted ON THE SERVER.
 *
 * Same reasoning as `fmtDate`: the container has TZ set, the browser has the
 * viewer's, and a component that formats in both places renders two different
 * strings for one instant — a hydration mismatch. Format once, pass the string.
 */
export function fmtTime(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86400_000], ['hour', 3600_000], ['minute', 60_000], ['second', 1000],
  ];
  const rtf = new Intl.RelativeTimeFormat('uk', { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(Math.round(diffMs / ms), unit);
  }
  return '—';
}

export function truncate(s: string | null | undefined, n = 120): string {
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Human label for a job that is parked on the subscription limit. */
export function retryWaitLabel(nextAttemptAt: Date | string | null): string {
  if (!nextAttemptAt) return 'пауза: ліміт підписки';
  return `пауза: ліміт підписки, відновиться ${fmtDate(nextAttemptAt)}`;
}

/**
 * Only http(s) URLs may reach an href. Scraped values (business websites,
 * social profiles, source URLs) are untrusted; a `javascript:` scheme here
 * would run under the authenticated UI origin. Non-http → undefined (link
 * renders inert). `viber://` deep links are built by our own code, not here.
 */
export function safeHttpUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : undefined;
  } catch { return undefined; }
}

/**
 * Ukrainian plural agreement: 1 запит, 2 запити, 5 запитів.
 *
 * Slavic languages have three plural forms, not two, so the English
 * `n === 1 ? x : xs` produces "1 запитів" — the kind of small wrongness that
 * makes an interface feel machine-written.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/**
 * Honest label for a business's "website" link. Google Maps' website field
 * often holds an Instagram/Facebook/booking profile; calling that «їхній сайт»
 * misleads the operator (a social profile is NOT an owned site — same rule as
 * the audit verdict). Label the link by what it actually is.
 */
export function linkLabel(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h.includes('instagram.com')) return 'їхній Instagram';
    if (h.includes('facebook.com') || h === 'fb.com') return 'їхній Facebook';
    if (h.includes('tiktok.com')) return 'їхній TikTok';
    if (h.includes('booksy.com') || h.includes('treatwell') || h.includes('fresha.com') || h.includes('setmore.com')) return 'їхній профіль бронювання';
    if (h.includes('linktr.ee')) return 'їхній Linktree';
    return 'їхній сайт';
  } catch { return 'їхній сайт'; }
}
