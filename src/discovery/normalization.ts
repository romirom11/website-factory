export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.length >= 8 ? digits : null;
}

export function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const directories = [
      'facebook.com', 'instagram.com', 'booksy.com', 'fresha.com',
      'treatwell.gr', 'linktr.ee', 'business.site',
    ];
    return directories.some((directory) => host.endsWith(directory)) ? null : host;
  } catch {
    return null;
  }
}

export function slugify(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'business';
}

export function normalizeName(name: string): string {
  return name.toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9α-ω]+/g, ' ')
    .trim();
}

export function geoClose(
  aLat: number | null,
  aLng: number | null,
  bLat: number | null,
  bLng: number | null,
): boolean {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return false;
  const dLat = (aLat - bLat) * 111_000;
  const dLng = (aLng - bLng) * 111_000 * Math.cos((aLat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) < 150;
}
