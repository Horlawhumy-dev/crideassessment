import type { DriverLocation, GeoPoint, Money, RideStatus } from '../types';

/**
 * The map, as an interface.
 *
 * §5.9 says the map is a concern of the view, and §5.3 says the app must not
 * depend on a map library. Both are honoured by this file: a feature depends on
 * `MapView`, `MapMarker` and `MapRoute`, and MapLibre happens to be the thing
 * that implements them. The previous app imported `react-leaflet` directly in a
 * component, which is why Leaflet, its CSS, its marker icon fix and a
 * `window` guard for SSR all had to be dealt with by whatever screen used it.
 *
 * Swapping MapLibre for Google Maps or a native map view is one new file and
 * zero changes to any feature.
 */

export interface MapCamera {
  center: GeoPoint;
  /** Degrees of longitude per pixel. */
  zoom?: number;
  bearing?: number;
  pitch?: number;
}

export interface MapViewProps {
  pickup: GeoPoint | null;
  dropoff: GeoPoint | null;
  driverLocation: DriverLocation | null;
  status: RideStatus | null;
  /**
   * Where the driver has actually been, oldest first.
   *
   * §5.13 specifies the map as `markers + route?: GeoPoint[]`, and this field is
   * what finally satisfies it. The interface previously had no route at all, so
   * the map fell back to a straight line between the two endpoints and the
   * rendered line bore no relation to where the car was — the thing a rider
   * watches to answer "is it moving towards me?" never answered anything.
   *
   * The polyline is accumulated from the live `ride:driver_location_update`
   * frames, so it is the road the driver drove and not a route planned for them.
   */
  route?: GeoPoint[] | null;
  /** Lets a driver pick a point during request. Off by default. */
  onPick?: (point: GeoPoint) => void;
  className?: string;
  /** Fit the route, or centre on the driver once there is one. */
  followDriver?: boolean;
  fare?: Money | null;
  children?: React.ReactNode;
}

export interface MapMarkerProps {
  point: GeoPoint;
  kind: 'pickup' | 'dropoff' | 'driver' | 'user';
  label?: string;
  heading?: number | null;
}

export interface MapRouteProps {
  points: GeoPoint[];
  /** 'solid' for a real route, 'dashed' for a simulated one. */
  variant?: 'solid' | 'dashed';
}

/** One drawn line: an ordered list of points, and what kind of line it is. */
export type MapRoute = Required<MapRouteProps>;
