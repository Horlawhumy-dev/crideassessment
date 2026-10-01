import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import type { FarePolicy } from '../domain/fare';

/** The one place environment variables become a `FarePolicy`, so `estimateFare` stays pure
 *  and the domain never reads process.env. */
@Injectable()
export class FarePolicyProvider {
  readonly policy: FarePolicy;

  constructor(config: ConfigService) {
    // `get<AppConfig>(APP_CONFIG)!`, not the `{ infer: true }` overload: APP_CONFIG is
    // a plain string token, so `infer` widens every field to string | number | boolean.
    const app = config.get<AppConfig>(APP_CONFIG)!;

    this.policy = {
      baseFareMinor: BigInt(app.FARE_BASE_MINOR),
      perKmMinor: BigInt(app.FARE_PER_KM_MINOR),
      perMinuteMinor: BigInt(app.FARE_PER_MINUTE_MINOR),
      minimumFareMinor: BigInt(app.FARE_MINIMUM_MINOR),
      currency: app.FARE_CURRENCY,
    };
  }
}

/** A use-case depends on this token, not on the provider, so a test can supply a literal
 *  policy without constructing a ConfigService. */
export const FARE_POLICY = 'FARE_POLICY';
