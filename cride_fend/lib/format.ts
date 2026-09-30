import type { Money } from './types';

/**
 * Presentation only. Every conversion between minor units and a human string
 * happens here and nowhere else, so a fare can never be rendered two ways.
 *
 * `amountMinor` is a *string* end to end — a BigInt in the domain, a string at
 * the mapper, a string on the wire — because a JSON number cannot represent
 * 2^53 minor units exactly and silently losing the last digits of a fare is
 * worse than a parse. It is parsed with BigInt, not parseInt.
 */

/**
 * Decimal places per currency.
 *
 * Naira is subdivided into 100 kobo, so two places — the value is a *count of
 * decimal places*, not a multiplier. An earlier version stored the multiplier
 * (100) and used it as an exponent, producing `10n ** 100n` and rendering every
 * fare as `₦0.000…000`. The test `expect(formatMoney({amountMinor:'10300',…}))
 * .toBe('₦103.00')` is what found it, which is the argument for having one.
 */
const DECIMAL_PLACES: Record<string, number> = {
  NGN: 2, // kobo
  USD: 2, // cents
  EUR: 2,
  GBP: 2,
};

export class MoneyFormatError extends Error {}

/** `₦103.00` — grouped, two decimals, correct symbol. */
export function formatMoney(money: Money | null | undefined): string {
  if (!money) return '—';

  const places = DECIMAL_PLACES[money.currency] ?? 2;
  let minor: bigint;
  try {
    minor = BigInt(money.amountMinor);
  } catch {
    // A malformed amount is a contract break, not a rendering problem. Surfacing
    // it as '—' would hide a bug behind a plausible-looking dash.
    throw new MoneyFormatError(`Unparseable amountMinor: ${money.amountMinor}`);
  }

  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = 10n ** BigInt(places);
  const major = abs / divisor;
  const remainder = (abs % divisor).toString().padStart(places, '0');

  const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currencySymbol(money.currency);
  return `${negative ? '-' : ''}${symbol}${grouped}.${remainder}`;
}

/** Just the digits, for a fare that sits next to its currency elsewhere. */
export function formatAmount(money: Money | null | undefined): string {
  return formatMoney(money).replace(/^[^\d-]+/, '');
}

export function currencySymbol(code: string): string {
  switch (code) {
    case 'NGN':
      return '₦';
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    default:
      return `${code} `;
  }
}

/* ---- Distance and duration ---- */

/** Matches the backend's haversine (kernel/geo-point.ts) closely enough to pre-fill an estimate. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '—';
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Mirrors `AVERAGE_SPEED_KPH = 30` in the backend's fare policy. */
const AVERAGE_SPEED_KPH = 30;

export function estimateDurationMs(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return Math.round((distanceMetres(a, b) / 1000 / AVERAGE_SPEED_KPH) * 3_600_000);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

/* ---- Time ---- */

/**
 * Deliberately coarse. A rider watching a countdown wants "in 2 min", not a
 * value that changes every second; a ride that already started wants a clock
 * time, not a relative one.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  return formatDateTime(iso);
}

export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Short, human ride reference. The id is a uuid and must never be shown raw. */
export function rideReference(id: string): string {
  return `#${id.slice(0, 4).toUpperCase()}`;
}

export function formatSpeed(kph: number | null): string | null {
  if (kph == null || !Number.isFinite(kph) || kph <= 0) return null;
  return `${Math.round(kph)} km/h`;
}

export function formatHeading(heading: number | null): string | null {
  if (heading == null || !Number.isFinite(heading)) return null;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(((heading % 360) + 360) % 360 / 45) % 8];
}
