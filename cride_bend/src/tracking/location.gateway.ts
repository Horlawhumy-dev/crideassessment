import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { SocketAuth } from '../auth/socket-auth.gateway';
import { distanceMetres, isValidCoordinate, round } from '../kernel/geo-point';
import { LOCATION_STORE, type DriverLocation, type LocationStore } from './location.store';
import { ROUTE_BUFFER, type RouteBuffer } from './route-buffer.port';
import { canPublishLocation } from '../rides/domain/ride-policy';
import { RIDE_REPOSITORY, type RideRepository } from '../rides/application/ports/ride.repository';

interface Frame {
  rideId: string;
  lat: number;
  lng: number;
  heading?: number;
  speedKph?: number;
  accuracyM?: number;
}

/**
 * Ordered ingress: ownership and ride status (shared policy), Redis rate limit,
 * coordinate bounds, teleport check. The last two are Redis-backed — a per-process
 * limiter resets on deploy and a second API instance bypasses it entirely.
 */
@WebSocketGateway({
  namespace: '/rides',
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true },
})
export class LocationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(LocationGateway.name);

  constructor(
    private readonly auth: SocketAuth,
    @Inject(RIDE_REPOSITORY) private readonly rides: RideRepository,
    @Inject(LOCATION_STORE) private readonly store: LocationStore,
    @Inject(ROUTE_BUFFER) private readonly track: RouteBuffer,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      socket.data.principal = this.auth.authenticate(socket);
    } catch {
      // Nothing logged: an unauthenticated socket is uninteresting, and the token must not be logged.
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    delete socket.data.principal;
  }

  @SubscribeMessage('ride:driver_location')
  async onLocation(@ConnectedSocket() socket: Socket, @MessageBody() frame: Frame) {
    const principal = socket.data.principal;
    if (!principal) return { ok: false, code: 'MISSING_TOKEN' };

    const cfg = this.config.get<AppConfig>(APP_CONFIG)!;

    // 1-3 role, existence, ownership and status, via the shared policy so HTTP and socket cannot drift.
    const ride = await this.rides.findById(frame.rideId);
    if (!ride) return { ok: false, code: 'RIDE_NOT_FOUND' };
    if (!canPublishLocation(ride, principal, ride.status)) {
      return { ok: false, code: 'NOT_ASSIGNED_DRIVER' };
    }

    // 4 rate limit, claimed before validation so invalid frames cannot buy extra quota.
    const rateKey = `loc:rate:${principal.userId}:${frame.rideId}`;
    if (!(await this.store.claim(rateKey, cfg.LOCATION_MIN_INTERVAL_MS))) {
      return { ok: false, code: 'RATE_LIMITED' };
    }

    // 5 sanity bounds: coordinate validity and reported accuracy.
    if (!isValidCoordinate(frame.lat, frame.lng)) {
      return { ok: false, code: 'INVALID_COORDINATES' };
    }
    if (frame.accuracyM !== undefined && frame.accuracyM > 200) {
      return { ok: false, code: 'INVALID_COORDINATES' };
    }

    const position = round({ lat: frame.lat, lng: frame.lng });

    // 6 teleport check, against the last *accepted* position so it survives a
    // reconnect and works across instances.
    const previous = await this.store.get(frame.rideId);
    if (previous && distanceMetres(previous.position, position) > cfg.LOCATION_MAX_JUMP_METRES) {
      this.logger.warn('location.jump_rejected', {
        rideId: frame.rideId,
        metres: Math.round(distanceMetres(previous.position, position)),
        correlationId: socket.handshake.auth?.correlationId,
      });
      return { ok: false, code: 'INVALID_COORDINATES' };
    }

    const location: DriverLocation = {
      driverId: principal.userId,
      position,
      heading: frame.heading ?? null,
      speedKph: frame.speedKph ?? null,
      accuracyM: frame.accuracyM ?? null,
      recordedAt: new Date(),
    };

    await this.store.put(frame.rideId, location, cfg.LOCATION_TTL_SECONDS);
    await this.store.publish(frame.rideId, location);

    // Buffer last, and deliberately allowed to fail: the frame is already published, so
    // a Redis hiccup costs one point of a cosmetic trail rather than the update a rider
    // is watching move. That ordering is what makes swallowing it safe.
    await this.track
      .append(frame.rideId, {
        lat: position.lat,
        lng: position.lng,
        speedKph: location.speedKph,
        headingDeg: location.heading,
        recordedAt: location.recordedAt,
      })
      .catch((err: unknown) => {
        this.logger.warn('route.buffer_append_failed', {
          rideId: frame.rideId,
          err: err instanceof Error ? err.message : String(err),
        });
      });

    return { ok: true, recordedAt: location.recordedAt.toISOString() };
  }
}
