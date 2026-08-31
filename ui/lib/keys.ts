/**
 * Pure key/link helpers. Kept out of `actions.ts` because a `'use server'`
 * module may only export async functions.
 *
 * Outreach idempotency is factory-owned; the UI submits domain commands and
 * never derives queue keys itself.
 */

export const MANUAL_CHANNELS: ReadonlySet<string> = new Set(['instagram', 'viber']);

export function isManualChannel(channel: string): boolean {
  return MANUAL_CHANNELS.has(channel);
}

/** Deep link Roman taps for a manual channel (and the wa.me fallback). */
export function deepLinkFor(channel: string, toAddress: string, body: string): string {
  const digits = toAddress.replace(/[^\d]/g, '');
  switch (channel) {
    case 'instagram': {
      const handle = (toAddress.match(/instagram\.com\/([^/?#]+)/i)?.[1] ?? toAddress)
        .replace(/^@/, '').replace(/\/+$/, '').trim();
      return `https://instagram.com/${handle}`;
    }
    case 'viber': return `viber://chat?number=%2B${digits}`;
    case 'whatsapp': return `https://wa.me/${digits}?text=${encodeURIComponent(body)}`;
    default: return '';
  }
}
