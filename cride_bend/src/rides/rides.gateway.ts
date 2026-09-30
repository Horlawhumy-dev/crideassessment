import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Inject } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { SocketAuth } from '../auth/socket-auth.gateway';
import { DriverAvailabilityService } from '../driver/driver-availability.service';
import { canSubscribeToRide, type Principal } from './domain/ride-policy';
import { toResponse, toWireEvent } from './infrastructure/rides.mapper';
import type { Ride } from './domain/ride';
import { GetRideUseCase } from './application/get-ride.use-case';
import { TransitionRideUseCase } from './application/transition-ride.use-case';
import { DomainError, RideNotFoundError } from '../common/errors/domain-error';
import { EVENT_BUS, RIDE_EVENT_TOPIC, type EventBus } from '../platform/realtime/event-bus.port';
import { EgressGuard } from '../platform/realtime/egress-guard';

const NAMESPACE = '/rides';

export const RIDE_ROOM = (rideId: string) => `ride:${rideId}`;
export const DRIVER_ROOM = (driverId: string) => `driver:${driverId}`;
export const AVAILABLE_DRIVERS_ROOM = 'drivers:available';

/** §4.9 — the client-facing name of a driver position update. */
export const DRIVER_LOCATION_EVENT = 'ride:driver_location_update';

/**
 * §4.8 — the realtime surface.
 *
 * Three responsibilities, kept separate on purpose:
 *
 *  1. Authenticate the handshake, once, in handleConnection. Doing it per message
 *     would re-verify a signature for every GPS ping.
 *  2. Fan out committed ride events to subscribed rooms. This gateway does NOT
 *     decide anything about rides; it only delivers what the outbox already
 *     committed. The `ride:transition` message is the single exception, and it
 *     calls the same use-case the HTTP route calls, so there is exactly one way a
 *     ride state can change.
 *  3. Serve the resync snapshot, so a client that missed a frame can repair itself.
 */
@WebSocketGateway({ namespace: NAMESPACE })
export class RidesGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server?: Server;

  private unsubscribe?: () => void;

  constructor(
    private readonly auth: SocketAuth,
    private readonly getRide: GetRideUseCase,
    private readonly transition: TransitionRideUseCase,
    private readonly availability: DriverAvailabilityService,
    // EventBus is an interface, so it is erased at compile time and
    // `design:paramtypes` can only report `Object`. Without the explicit token
    // Nest looks for a provider literally named "Object" and the gateway cannot
    // be constructed.
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly egressGuard: EgressGuard,
  ) {}

  /**
   * Subscribes to committed ride events.
   *
   * The cross-instance adapter is NOT set here — see platform/realtime/
   * redis-io.adapter.ts for why it has to be installed before the server starts.
   */
  afterInit(_server: Server): void {
    this.unsubscribe = this.bus.subscribe(RIDE_EVENT_TOPIC, (raw) => {
      this.dispatch(raw as RideEventMessage);
    });
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
  }

  /**
   * Every instance receives this event from the bus, and the adapter fans each
   * re-emit out to all nodes, so an unguarded dispatch delivers the event to a
   * client once per running instance. One instance claims the event and emits;
   * the others stand down. See EgressGuard.
   *
   * The key carries the event name and audience alongside the id because one
   * committed event legitimately publishes several messages — `ride.accepted`
   * produces a `ride:status_changed` *and* a `ride:assigned` — and those are
   * different things a client must receive, not duplicates of each other.
   */
  private dispatch(message: RideEventMessage): void {
    if (!this.server) return;

    const { audience, audienceId, event, payload } = message;
    const key = `${String(payload['eventId'])}|${event}|${audience}|${audienceId ?? ''}`;

    void this.egressGuard.claimOnce(key).then((claimed) => {
      if (!claimed) return;
      this.emit(message);
    });
  }

  private emit({ audience, audienceId, event, payload, rideId }: RideEventMessage): void {
    if (audience === 'ride') {
      this.server?.to(RIDE_ROOM(rideId)).emit(event, payload);
      return;
    }
    if (audience === 'drivers') {
      this.server?.to(AVAILABLE_DRIVERS_ROOM).emit(event, payload);
      return;
    }
    if (audience === 'driver' && audienceId) {
      this.server?.to(DRIVER_ROOM(audienceId)).emit(event, payload);
    }
  }

  handleConnection(socket: Socket): void {
    try {
      const principal = this.auth.authenticate(socket);
      socket.data.principal = principal;
      // A driver's personal channel is joined at connect time; ride rooms are
      // joined explicitly, since joining one is an authorization decision.
      socket.join(DRIVER_ROOM(principal.userId));
      // The shared availability channel is *not* blanket-joined. Joining it means
      // "send me every new ride request", which is exactly what a driver who has
      // gone unavailable has declined, so it is gated on the persisted flag.
      // The read is async, so it is fired and not awaited; a driver who is
      // mid-restore is joined as soon as the read resolves.
      if (principal.role === 'DRIVER') void this.syncAvailabilityRoom(socket, principal);
    } catch {
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    delete socket.data.principal;
  }

  /**
   * §4.9 — the availability toggle, over the socket.
   *
   * The REST route is what makes the value durable; this message is what makes it
   * take effect now. Both are needed: a client that only sent the socket message
   * would forget the state on reload, and a client that only sent the REST call
   * would keep receiving offers until it reconnected.
   *
   * The persisted flag is written by the REST route, which the client calls first;
   * this handler reads it back rather than trusting the payload, so the room and
   * the database can never disagree.
   */
  @SubscribeMessage('driver:availability')
  async onAvailability(@ConnectedSocket() socket: Socket) {
    const principal = this.requirePrincipal(socket);
    if (principal.role !== 'DRIVER') throw new DomainError('FORBIDDEN_ROLE');

    await this.syncAvailabilityRoom(socket, principal);
    return { ok: true, isAvailable: socket.rooms.has(AVAILABLE_DRIVERS_ROOM) };
  }

  private async syncAvailabilityRoom(socket: Socket, principal: Principal): Promise<void> {
    try {
      const { isAvailable } = await this.availability.get(principal);
      if (isAvailable) {
        await socket.join(AVAILABLE_DRIVERS_ROOM);
      } else {
        await socket.leave(AVAILABLE_DRIVERS_ROOM);
      }
    } catch {
      // A driver whose profile cannot be read is simply not offered rides. This
      // must not disconnect them: they can still work a ride they already hold.
    }
  }

  @SubscribeMessage('ride:join')
  async onJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { rideId: string; lastSeq?: number },
  ) {
    const principal = this.requirePrincipal(socket);
    const detail = await this.loadVisibleRide(body.rideId, principal);

    if (!canSubscribeToRide(detail.ride, principal)) {
      // 404-shaped, so the socket is not an enumeration oracle either.
      throw new RideNotFoundError(body.rideId);
    }

    await socket.join(RIDE_ROOM(detail.ride.id));

    // The snapshot reuses the ride already authorised and loaded above. Re-reading
    // it through a synthetic principal would either fail its own ownership check or
    // smuggle in a bypass path.
    return this.snapshot(detail.ride, body.lastSeq ?? 0);
  }

  @SubscribeMessage('ride:leave')
  async onLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { rideId: string },
  ) {
    await socket.leave(RIDE_ROOM(body.rideId));
    return { ok: true };
  }

  /** §4.8.3 — the resync. Detects gaps instead of assuming there are none. */
  @SubscribeMessage('ride:sync')
  async onSync(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { rideId: string; lastSeq: number },
  ) {
    const principal = this.requirePrincipal(socket);
    const detail = await this.loadVisibleRide(body.rideId, principal);
    if (!canSubscribeToRide(detail.ride, principal)) throw new RideNotFoundError(body.rideId);
    return this.snapshot(detail.ride, body.lastSeq);
  }

  /**
   * The socket write path for state changes. It calls the use-case, so the state
   * machine, the ownership rules, the version check, the event log and the outbox
   * all apply identically to a socket-originated change.
   */
  @SubscribeMessage('ride:transition')
  async onTransition(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { rideId: string; to: string; version?: number; reason?: string },
  ) {
    const principal = this.requirePrincipal(socket);
    const correlationId = `ws:${socket.id}`;

    const ride = await this.transition.execute(
      principal,
      body.rideId,
      {
        to: body.to as never,
        version: body.version,
        reason: body.reason,
      },
      correlationId,
    );

    // No direct emit here: the outbox relay publishes the authoritative event.
    // Emitting as well would deliver the same change twice.
    return { ok: true, version: ride.version, status: ride.status };
  }

  /** Called by handlers on this instance; also used by tests. */
  emitToRide(rideId: string, event: string, payload: unknown): void {
    this.server?.to(RIDE_ROOM(rideId)).emit(event, payload);
  }

  /**
   * §4.9 — the only way a position reaches a client.
   *
   * Room membership is reused rather than a second, location-specific join
   * decision: anyone who is entitled to see a ride's events is entitled to see
   * where the driver is, so `ride:join` already made that authorization call.
   * A second join path would be a second opportunity to get it wrong.
   *
   * The shape is DTO-ish rather than the `DriverLocation` object so the wire
   * contract is decided here, at the boundary, and not inherited from whatever
   * the store happens to hold. `recordedAt` is a string because Date does not
   * survive JSON.
   */
  emitDriverLocation(rideId: string, location: DriverLocationView): void {
    this.server?.to(RIDE_ROOM(rideId)).emit(DRIVER_LOCATION_EVENT, {
      rideId,
      driverId: location.driverId,
      lat: location.position.lat,
      lng: location.position.lng,
      heading: location.heading,
      speedKph: location.speedKph,
      accuracyM: location.accuracyM,
      recordedAt: location.recordedAt.toISOString(),
    });
  }

  emitToAvailableDrivers(event: string, payload: unknown): void {
    this.server?.to(AVAILABLE_DRIVERS_ROOM).emit(event, payload);
  }

  emitToDriver(driverId: string, event: string, payload: unknown): void {
    this.server?.to(DRIVER_ROOM(driverId)).emit(event, payload);
  }

  /**
   * The resync payload, as a client would receive it.
   *
   * Both projections are load-bearing. `toResponse` because a `Ride` carries
   * `fare: Money`, whose `amountMinor` is a `bigint` by design (D5), and every ride
   * has a fare because one is estimated at creation — so returning the domain
   * object made socket.io's `JSON.stringify` throw "Do not know how to serialize
   * a BigInt" on *every* `ride:join`, `ride:sync` and `ride:transition` reply. The
   * realtime read path was dead for all rides, and only a real socket client could
   * have surfaced it, because HTTP goes through a controller that already projects.
   *
   * `toWireEvent` for the same class of reason: `createdAt` is a `Date`, which
   * socket.io happens to render as an ISO string, so leaving it to the serializer
   * would make the wire shape an accident of the transport rather than a
   * decision. Projecting explicitly is what lets the client rely on it.
   */
  private async snapshot(ride: Ride, lastSeq: number) {
    const events = await this.getRide.eventsAfter(ride, lastSeq);
    return {
      ride: toResponse(ride),
      events: events.map(toWireEvent),
      lastSeq: events.at(-1)?.seq ?? lastSeq,
    };
  }

  private async loadVisibleRide(rideId: string, principal: Principal) {
    try {
      return await this.getRide.execute(rideId, principal);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new RideNotFoundError(rideId);
    }
  }

  private requirePrincipal(socket: Socket): Principal {
    const principal = socket.data.principal as Principal | undefined;
    if (!principal) throw new DomainError('MISSING_TOKEN');
    return principal;
  }
}

interface RideEventMessage {
  readonly rideId: string;
  readonly audience: 'ride' | 'drivers' | 'driver';
  readonly audienceId?: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The subset of `DriverLocation` this gateway needs, declared structurally rather
 * than imported from `tracking` — the two modules deliberately do not depend on
 * each other's types, and a structural type keeps that true in both directions.
 */
interface DriverLocationView {
  readonly driverId: string;
  readonly position: { readonly lat: number; readonly lng: number };
  readonly heading: number | null;
  readonly speedKph: number | null;
  readonly accuracyM: number | null;
  readonly recordedAt: Date;
}

export { NAMESPACE };
