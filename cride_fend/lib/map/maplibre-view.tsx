'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { cn } from '@/lib/utils';
import type { DriverLocation, GeoPoint, Money, RideStatus } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import type { MapMarkerProps, MapRoute, MapViewProps } from './types';

/**
 * The MapLibre implementation of the map interface. The only file in the app
 * that knows this library exists.
 *
 * Two decisions worth defending:
 *
 * 1. **OpenStreetMap raster tiles, not a vector style.** The styled alternatives
 *    need an account and a token, and a token that is missing at demo time
 *    produces a grey rectangle rather than an error. OSM's tile policy also
 *    forbids heavy use from a demo, so the attribution is kept and the usage is
 *    a handful of users.
 *
 * 2. **Markers are DOM elements, not layers.** With a handful of markers, DOM
 *    markers are simpler, styleable with the same token system as everything
 *    else, and — this is the part that matters — a driver marker can be a real
 *    element with real text, so its heading is readable rather than being a
 *    rotated image.
 *
 * Every colour here is a token. `check-no-arbitrary-colors.mjs` exempts this
 * file precisely because MapLibre's imperative API needs literal values at
 * runtime, where a Tailwind class does not exist yet.
 */

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#e8e4dd' } },
    { id: 'osm', type: 'raster', source: 'osm' },
  ],
};

/** Osogbo. A fixed initial view, so the map opens on the city it operates in. */
const OSOGBO: GeoPoint = { lat: 7.7786, lng: 4.5526 };

/**
 * Resolve a design token to a colour MapLibre can actually parse.
 *
 * The tokens are `oklch()` (§globals.css). That is correct for the DOM and wrong
 * for MapLibre: its paint properties are parsed as CSS *Color 3* — hex, `rgb()`,
 * `rgba()`, and named colours — and a `lab()` or `oklch()` string is rejected
 * with a console error while the layer is still added, so the route silently
 * renders with no colour rather than throwing.
 *
 * Reading the token and handing it over unchanged is the mistake that produced
 * exactly that. `getComputedStyle` faithfully returns `oklch(0.52 0.115 180)`, or
 * its `lab()` equivalent, and the browser's serialisation of the value is not
 * something this code can predict.
 *
 * So the value goes through the one component that is guaranteed to understand
 * every colour syntax the platform has: a 1×1 canvas. Painting the colour and
 * reading the pixel back yields sRGB bytes whatever space the colour was written
 * in, which is a format MapLibre always accepts. No dependency, no hand-written
 * oklch→sRGB matrix, and nothing to keep in step with the tokens.
 */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return fallback;
  return toSrgb(value) ?? fallback;
}

let scratch: CanvasRenderingContext2D | null | undefined;

function toSrgb(color: string): string | null {
  try {
    // Validate first, and with `CSS.supports` rather than a sentinel colour.
    //
    // The first version of this function reset `fillStyle` to `#ff00ff` and
    // treated an unrecognised value as "unchanged" — which does not work:
    // assigning an invalid colour leaves `fillStyle` at its previous value and
    // paints nothing readable as an error, so a malformed token produced a
    // magenta route instead of the fallback. `CSS.supports('color', …)` is the
    // platform's own colour parser, so it answers "is this a colour" exactly,
    // and the canvas is left to answer only "what are its sRGB bytes".
    if (!CSS.supports('color', color)) return null;

    scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!scratch) return null;

    const { canvas } = scratch;
    canvas.width = 1;
    canvas.height = 1;
    scratch.clearRect(0, 0, 1, 1);
    scratch.fillStyle = color;
    scratch.fillRect(0, 0, 1, 1);

    const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data;
    // Nothing was painted, so the value was not a colour this context can render.
    if (a === 0) return null;

    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  } catch {
    // A tainted or unavailable context is not worth failing a map over.
    return null;
  }
}

const MARKER_CLASS: Record<MapMarkerProps['kind'], string> = {
  pickup: 'map-marker-pickup',
  dropoff: 'map-marker-dropoff',
  driver: 'map-marker-driver',
  user: 'map-marker-user',
};

const MARKER_GLYPH: Record<MapMarkerProps['kind'], string> = {
  pickup: '●',
  dropoff: '■',
  driver: '▲',
  user: '◎',
};

/* ---- Route geometry --------------------------------------------------------
 * Two lines, because "direction" on a live map is two questions: where has the
 * car been, and where is it going. Drawing one line for both answers is why the
 * map looked static — a single pickup→dropoff segment is identical before the
 * driver sets off and after they arrive, so nothing a rider watched ever moved.
 * ------------------------------------------------------------------------- */

/** What a line layer's GeoJSON source holds. No features means "draw nothing". */
type LineData = GeoJSON.FeatureCollection<GeoJSON.LineString>;

const LINE_PAINT: Record<MapRoute['variant'], maplibregl.LineLayerSpecification['paint']> = {
  solid: { 'line-width': 4, 'line-opacity': 0.9 },
  dashed: { 'line-width': 3, 'line-opacity': 0.4, 'line-dasharray': [2, 2] },
};

/**
 * Points to GeoJSON.
 *
 * Fewer than two coordinates is not a line, and MapLibre draws nothing for one —
 * silently, which is indistinguishable from a layer that was never added. So the
 * short cases are an empty feature collection: a car that has moved nowhere has no
 * line to draw, and the empty source says exactly that.
 */
function lineFeature(points: GeoPoint[]): LineData {
  const coordinates = points.map((point) => [point.lng, point.lat]);

  // A repeated coordinate is not a segment. Trimming the tail means a driver who
  // has reached their destination empties the layer instead of leaving a
  // zero-length stub sitting on the endpoint.
  while (coordinates.length >= 2) {
    const last = coordinates[coordinates.length - 1];
    const previous = coordinates[coordinates.length - 2];
    if (previous[0] !== last[0] || previous[1] !== last[1]) break;
    coordinates.pop();
  }

  return coordinates.length < 2
    ? { type: 'FeatureCollection', features: [] }
    : {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }],
      };
}

/**
 * Create the layer once, then only ever update its geometry.
 *
 * `setData` is what lets this effect run on every location frame: it is a buffer
 * update rather than a teardown. Rebuilding the source on each run — which is what
 * the previous version did — discards the layer and re-resolves every paint
 * property from the DOM, so it is both slower and a second place for the token
 * lookup to fail without anything being drawn.
 */
function setLine(instance: MapLibreMap, id: string, route: MapRoute, color: string): void {
  const data = lineFeature(route.points);
  const source = instance.getSource(id) as maplibregl.GeoJSONSource | undefined;

  if (source) {
    source.setData(data);
    return;
  }

  instance.addSource(id, { type: 'geojson', data });
  instance.addLayer({
    id,
    type: 'line',
    source: id,
    paint: { 'line-color': color, ...LINE_PAINT[route.variant] },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
}

/**
 * Where the driver is headed next.
 *
 * `ACCEPTED` means the driver is still on the way to the *pickup*, so pointing the
 * remaining line at the dropoff draws a journey that has not started — the line
 * would run away from the car in a direction the car is not going. `IN_PROGRESS`
 * is the trip. A terminal ride has nothing left to show. A `REQUESTED` ride has no
 * driver yet, so it falls back to the pickup→dropoff segment the map always drew.
 */
function nextWaypoint(status: RideStatus | null, pickup: GeoPoint | null, dropoff: GeoPoint | null): GeoPoint | null {
  if (status === 'COMPLETED' || status === 'CANCELLED') return null;
  if (status === 'ACCEPTED') return pickup;
  return dropoff;
}

export function MapView({
  pickup,
  dropoff,
  driverLocation,
  status,
  route,
  onPick,
  className,
  followDriver = true,
  fare,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /* ---- Init ------------------------------------------------------------- */

  useEffect(() => {
    if (!container.current || map.current) return;

    // `failIfMajorPerformanceCaveat` off, and a try/catch: MapLibre throws in a
    // jsdom or a WebGL-less browser, and an uncaught throw in a `useEffect`
    // takes down the whole route. A map that will not draw is a degraded screen,
    // not a broken app.
    let instance: MapLibreMap | null = null;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style: OSM_STYLE,
        center: [OSOGBO.lng, OSOGBO.lat],
        zoom: 13,
        attributionControl: false,
        failIfMajorPerformanceCaveat: false,
      });
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      instance.on('load', () => setReady(true));
      map.current = instance;
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : 'The map could not start.');
    }

    return () => {
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      // No layer teardown: `instance.remove()` drops the style and every source
      // with it, and the two route layers outlive neither a ride change nor a
      // cleared path — an emptied source renders nothing.
      instance?.remove();
      map.current = null;
    };
  }, []);

  /* ---- Click to pick ----------------------------------------------------- */

  useEffect(() => {
    const instance = map.current;
    if (!instance || !onPick) return;

    const handler = (event: maplibregl.MapMouseEvent) => {
      onPick({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };
    instance.on('click', handler);
    return () => {
      instance.off('click', handler);
    };
  }, [onPick, ready]);

  /* ---- Markers ----------------------------------------------------------- */

  const points = useMemo(() => {
    const list: { key: string; marker: MapMarkerProps }[] = [];
    if (pickup) list.push({ key: 'pickup', marker: { point: pickup, kind: 'pickup' } });
    if (dropoff) list.push({ key: 'dropoff', marker: { point: dropoff, kind: 'dropoff' } });
    if (driverLocation) {
      list.push({
        key: 'driver',
        marker: {
          point: { lat: driverLocation.lat, lng: driverLocation.lng },
          kind: 'driver',
          heading: driverLocation.heading,
          label: formatSpeedLabel(driverLocation.speedKph),
        },
      });
    }
    return list;
  }, [pickup, dropoff, driverLocation]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    markers.current.forEach((marker) => marker.remove());
    markers.current = points.map(({ key, marker }) => {
      const element = document.createElement('div');
      element.className = `map-marker ${MARKER_CLASS[marker.kind]}`;
      element.setAttribute('aria-label', `${marker.kind}${marker.label ? `: ${marker.label}` : ''}`);
      element.innerHTML = `<span class="map-marker__glyph">${MARKER_GLYPH[marker.kind]}</span>${
        marker.label ? `<span class="map-marker__label">${marker.label}</span>` : ''
      }`;
      if (marker.heading != null) {
        element.style.setProperty('--marker-heading', `${marker.heading}deg`);
      }
      return new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat([marker.point.lng, marker.point.lat])
        .addTo(instance);
    });
  }, [points, ready]);

  /* ---- Camera ------------------------------------------------------------ */

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    // Follow the driver only when there is one, and only while the ride is live:
    // once it is completed the camera should stop chasing a marker that is no
    // longer moving and show the whole journey instead.
    if (followDriver && driverLocation && status && !['COMPLETED', 'CANCELLED'].includes(status)) {
      instance.easeTo({ center: [driverLocation.lng, driverLocation.lat], duration: 900 });
      return;
    }

    // The journey, not just its endpoints. A road between two pins can bow well
    // outside the box they define, and a camera fitted to the pins would crop the
    // trip it is meant to be showing.
    const corners = [...(route ?? []), ...(pickup ? [pickup] : []), ...(dropoff ? [dropoff] : [])];
    if (corners.length > 1) {
      const bounds = corners.reduce(
        (box, point) => box.extend([point.lng, point.lat]),
        new maplibregl.LngLatBounds([corners[0].lng, corners[0].lat], [corners[0].lng, corners[0].lat]),
      );
      instance.fitBounds(bounds, { padding: 72, maxZoom: 15, duration: 700 });
    } else if (pickup) {
      instance.easeTo({ center: [pickup.lng, pickup.lat], zoom: 14, duration: 600 });
    }
  }, [pickup, dropoff, driverLocation, status, followDriver, ready, route]);

  /* ---- Route -------------------------------------------------------------
   * Two layers, updated with `setData` rather than torn down and rebuilt.
   *
   * The old version added one source and one layer per run and removed them
   * again on the next, from a dep array of `[pickup, dropoff, ready]`. Two
   * consequences: the line never moved, because the driver is not in the
   * dependency list, and every rebuild destroyed and recreated the source instead
   * of updating the one already there — the two ways this could have been done,
   * and it did neither.
   *
   * The travelled line is the driver's real track, accumulated from the location
   * frames, so it is a road and not an estimate. The remaining line is a straight
   * segment because the API has no routing service; dashed, because a solid line
   * would claim to be the road. It is anchored on the driver's *current* position,
   * which is what makes it shrink as the car advances rather than sitting still
   * between the two endpoints for the whole ride.
   * ---------------------------------------------------------------------- */

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    // The remaining line is anchored on where the car is *now*, which is what makes
    // it shorten as the car advances. Anchored on the pickup instead — as a fixed
    // pickup→dropoff segment is — it is the same line for the whole ride, which is
    // the thing that made the map look broken.
    const here = driverLocation ? { lat: driverLocation.lat, lng: driverLocation.lng } : pickup;
    const target = nextWaypoint(status, pickup, dropoff);

    const travelled: MapRoute = { variant: 'solid', points: route ?? [] };
    const remaining: MapRoute = {
      variant: 'dashed',
      points: here && target ? [here, target] : [],
    };

    // One read, not two. `token` is not free — it parses the value and paints a
    // pixel — and reading it per layer is how two lines end up subtly different
    // colours for no visible reason.
    const color = token('--primary', '#0f766e');
    setLine(instance, 'route-travelled', travelled, color);
    setLine(instance, 'route-remaining', remaining, color);
  }, [ready, pickup, dropoff, driverLocation, status, route]);

  if (failed) {
    return (
      <div className={cn('bg-muted text-muted-foreground flex items-center justify-center p-6 text-center text-sm', className)}>
        The map could not load. Your ride is unaffected — all the details are below.
      </div>
    );
  }

  return (
    <div className={cn('relative isolate overflow-hidden rounded-2xl border border-border', className)}>
      <div ref={container} className="absolute inset-0" aria-label="Ride map" role="img" />

      {!ready && (
        <div className="bg-muted/60 absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading map…
        </div>
      )}

      {fare && (
        <div className="bg-card/95 absolute top-3 left-3 rounded-xl border border-border px-3 py-2 text-sm font-semibold shadow-sm backdrop-blur">
          {formatMoney(fare)}
          <span className="text-muted-foreground ml-1 text-xs font-normal">estimate</span>
        </div>
      )}

      {onPick && (
        <p className="bg-card/95 text-muted-foreground absolute bottom-3 left-3 rounded-lg border border-border px-2.5 py-1.5 text-xs backdrop-blur">
          Tap the map to set your {pickup && !dropoff ? 'destination' : 'pickup'}
        </p>
      )}
    </div>
  );
}

function formatSpeedLabel(kph: number | null): string | undefined {
  if (kph == null || kph <= 0) return undefined;
  return `${Math.round(kph)} km/h`;
}
