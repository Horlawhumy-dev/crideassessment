import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LOCATION_STORE, type LocationStore } from './location.store';
import { RidesGateway } from '../rides/rides.gateway';
import { EgressGuard } from '../platform/realtime/egress-guard';

/**
 * Wires store.subscribe to RidesGateway.emitDriverLocation. It lives here because the
 * gateway owns room topology while short-lived Redis positions are tracking's business.
 */
@Injectable()
export class LocationEgress implements OnModuleInit {
  private readonly logger = new Logger(LocationEgress.name);
  private unsubscribe?: () => void;

  constructor(
    @Inject(LOCATION_STORE) private readonly store: LocationStore,
    private readonly gateway: RidesGateway,
    private readonly egressGuard: EgressGuard,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.store.subscribe((rideId, location) => {
      // Runs on every instance while the adapter fans the frame out to all of them, so
      // an unguarded call delivers it N times (see EgressGuard). The key is the frame's
      // identity: the rate limiter spaces a driver's frames too far apart to repeat it.
      const key = `loc|${rideId}|${location.driverId}|${location.recordedAt.toISOString()}`;
      void this.egressGuard.claimOnce(key).then((claimed) => {
        if (!claimed) return;
        // Emits into the ride:join room; there is deliberately no second join path.
        this.gateway.emitDriverLocation(rideId, location);
      });
    });

    this.logger.log('location.egress_started');
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }
}
