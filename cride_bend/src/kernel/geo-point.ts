export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/** ~0.1m at the equator: enough for dispatch, not enough to bloat rows. */
export const PRECISION = 6;

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function assertValidPoint(p: GeoPoint): GeoPoint {
  if (!isValidCoordinate(p.lat, p.lng)) {
    throw new Error(`invalid coordinate: ${p.lat},${p.lng}`);
  }
  return p;
}

/** Great-circle distance in metres. Haversine; accurate enough at city scale. */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Done once at the mapper boundary, so the cache key and the database row cannot
 * disagree.
 */
export function round(p: GeoPoint): GeoPoint {
  return {
    lat: Number(p.lat.toFixed(PRECISION)),
    lng: Number(p.lng.toFixed(PRECISION)),
  };
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
