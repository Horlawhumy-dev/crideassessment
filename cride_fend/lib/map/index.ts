/**
 * The barrel the app actually imports.
 *
 * Features import `@/lib/map` and never `maplibre-view`. If a feature reached
 * for the implementation the interface would stop being one, and MapLibre would
 * become a dependency of the app rather than an implementation detail of the
 * map.
 */
export type { MapCamera, MapMarkerProps, MapRoute, MapRouteProps, MapViewProps } from './types';
export { MapView } from './maplibre-view';
