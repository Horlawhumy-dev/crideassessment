/**
 * The contract, narrowed.
 *
 * Everything here is derived from `lib/generated/api.d.ts`, which is produced
 * from the backend's own OpenAPI document by `npm run gen:api` and diffed in CI.
 * This file exists only to give the application readable names and to strip the
 * two places the generated document is technically accurate but awkward to use.
 *
 * It must never grow a hand-written shape. If a field is missing, the fix is to
 * regenerate, not to add it here.
 */
import type { components, operations } from './generated/api';

type Schemas = components['schemas'];

/* ---- Identity ---- */

export type UserRole = Schemas['SessionUserDto']['role'];
export type SessionUser = Schemas['SessionUserDto'];
export type Principal = Schemas['PrincipalDto'];
export type AuthUser = Schemas['AuthUserDto'];
export type AuthSession = Schemas['AuthSessionResponseDto'];

/* ---- Rides ---- */

/** The single source of truth for the five ride states. */
export type RideStatus = Schemas['RideResponseDto']['status'];
export type GeoPoint = Schemas['CoordinateDto'];
export type Money = Schemas['MoneyDto'];
export type Ride = Schemas['RideResponseDto'];
export type RideDetail = Schemas['RideDetailResponseDto'];
export type RideEvent = Schemas['RideEventDto'];
export type RideListPage = Schemas['RideListResponseDto'];
export type RideActorRole = Schemas['RideEventDto']['actorRole'];

/* ---- Driver ---- */

export type DriverAvailability = operations['setDriverAvailability']['responses']['200']['content']['application/json'];

/* ---- Notifications ---- */

/**
 * The in-app inbox. Derived like everything else, so the `kind` union below is
 * whatever the backend's Prisma enum currently holds — a sixth kind stops this
 * app compiling at `NOTIFICATION_KIND_META` rather than rendering as an
 * unlabelled grey dot.
 */
export type InAppNotification = Schemas['InAppNotificationDto'];
export type InAppNotificationKind = InAppNotification['kind'];
export type NotificationListPage = Schemas['InAppNotificationListResponseDto'];
export type UnreadCount = Schemas['UnreadCountResponseDto'];

/* ---- Errors ---- */

export type ErrorCode = Schemas['ErrorResponseDto']['code'];
export type ErrorEnvelope = Schemas['ErrorEnvelopeDto'];
export type ValidationIssue = Schemas['ValidationIssueDto'];

/* ---- Request payloads ---- */

export type RequestRideInput = operations['requestRide']['requestBody']['content']['application/json'];
export type TransitionRideInput = operations['transitionRide']['requestBody']['content']['application/json'];
export type RegisterInput = operations['register']['requestBody']['content']['application/json'];
export type LoginInput = operations['login']['requestBody']['content']['application/json'];
export type ListRidesQuery = NonNullable<operations['listRideHistory']['parameters']['query']>;

/* ---------------------------------------------------------------------------
 * The two places the generated document is technically right and practically wrong.
 * ------------------------------------------------------------------------ */

/**
 * The REST detail projects five event fields; the socket's `toWireEvent` projects
 * nine. `driverId` and `eventType`-adjacent context are simply absent over HTTP.
 * Declaring the union honestly means a screen cannot accidentally reach for
 * `event.rideId` and get `undefined` at runtime with a type that said otherwise.
 */
export type RideEventLike = RideEvent & { rideId?: string; actorId?: string | null };

/** A live driver position, as delivered over the socket. */
export interface DriverLocation {
  rideId: string;
  driverId: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedKph: number | null;
  accuracyM: number | null;
  recordedAt: string;
}

/** A resync snapshot: authoritative state plus everything missed while away. */
export interface RideSnapshot {
  ride: Ride;
  events: RideEventLike[];
  lastSeq: number;
}
