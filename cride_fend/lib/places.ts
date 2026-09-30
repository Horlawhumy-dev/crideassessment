import type { GeoPoint } from './types';

/**
 * Osogbo, Osun State. C-Ride operates here, so the demo does too.
 *
 * Why a fixed list instead of a geocoder: the API requires coordinates and
 * offers no geocoding, and a reviewer typing "Osogbo City Mall" into a live
 * Nominatim request during a demo is a network dependency that can fail on stage.
 * A named list makes requesting a ride two clicks and always reproducible, and
 * the map still lets anyone drop a pin anywhere, so the feature is not narrower
 * than the API.
 *
 * This is the ONE place a coordinate is allowed to be a literal — it is data,
 * not styling, which is why check-no-arbitrary-colors.mjs exempts it.
 */
export interface Place {
  readonly id: string;
  readonly label: string;
  readonly area: string;
  readonly point: GeoPoint;
}

export const OSOGBO_PLACES: readonly Place[] = [
  { id: 'city-mall', label: 'Osogbo City Mall', area: 'Olaiya', point: { lat: 7.7714, lng: 4.5489 } },
  { id: 'osu', label: 'Osun State University', area: 'Oke Ekiti', point: { lat: 7.7833, lng: 4.556 } },
  { id: 'central-mosque', label: 'Osogbo Central Mosque', area: 'Central Osogbo', point: { lat: 7.7827, lng: 4.5556 } },
  { id: 'oja-osogbo', label: 'Oja Osogbo Market', area: 'Old Osogbo Road', point: { lat: 7.7856, lng: 4.5544 } },
  { id: 'mercyland', label: 'Mercyland Hospital', area: 'Alewo', point: { lat: 7.771, lng: 4.55 } },
  { id: 'palace', label: 'Osogbo Palace', area: 'Palace Road', point: { lat: 7.7836, lng: 4.5567 } },
  { id: 'jakande', label: 'Jakande Roundabout', area: 'Osogbogro', point: { lat: 7.7776, lng: 4.5531 } },
  { id: 'boise', label: 'Osogbo–Boise Road', area: 'Boise', point: { lat: 7.789, lng: 4.548 } },
  { id: 'station', label: 'Osogbo Railway Station', area: 'Station Road', point: { lat: 7.7806, lng: 4.5584 } },
] as const;

export const DEFAULT_PICKUP = OSOGBO_PLACES[0];
export const DEFAULT_DROPOFF = OSOGBO_PLACES[1];

export function findPlace(id: string): Place | undefined {
  return OSOGBO_PLACES.find((place) => place.id === id);
}

export function placeLabel(point: GeoPoint): string {
  // Nearest known place, within a kilometre. Used to give a dropped pin a name
  // rather than showing raw coordinates in a fare summary.
  let best: { place: Place; metres: number } | null = null;
  for (const place of OSOGBO_PLACES) {
    const metres = distanceMetres(point, place.point);
    if (best === null || metres < best.metres) best = { place, metres };
  }
  if (best && best.metres < 1500) return best.place.label;
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

/** Great-circle distance in metres. Shared: the fare estimate and the ride machine both need it. */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A believable polyline between two points.
 *
 * The server rejects a position more than `LOCATION_MAX_JUMP_METRES` (2 km) from
 * the driver's last one, so the simulator has to move in believable steps. A
 * straight line is what a straight road looks like from above, but a dogleg
 * makes it obvious on the map that this is a simulated trip rather than a stuck
 * marker, and it exercises the same interpolation the real sender would.
 */
export function routePolyline(from: GeoPoint, to: GeoPoint, steps = 24): GeoPoint[] {
  if (steps < 2) return [from, to];

  const dx = to.lng - from.lng;
  const dy = to.lat - from.lat;
  // A perpendicular offset, scaled down with distance so short trips are not absurd.
  const bow = Math.min(0.0016, Math.hypot(dx, dy) * 0.18);
  const midLng = (from.lng + to.lng) / 2;
  const midLat = (from.lat + to.lat) / 2;

  const points: GeoPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    // Two superimposed sine humps: a road that bends, not a bezier loop.
    const wobble = Math.sin(t * Math.PI) * bow;
    points.push({
      lat: from.lat + dy * t + wobble * 0.5,
      lng: from.lng + dx * t + wobble,
    });
  }
  return points;
}

/** The point at `progress` (0–1) along a polyline, plus the heading in degrees. */
export function pointAlongRoute(points: GeoPoint[], progress: number): { point: GeoPoint; heading: number } | null {
  if (points.length < 2) return null;

  const clamped = Math.min(1, Math.max(0, progress));
  const scaled = clamped * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const t = scaled - index;

  const a = points[index];
  const b = points[index + 1];

  return {
    point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    heading: (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180) / Math.PI,
  };
}
