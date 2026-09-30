import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import type { FarePolicy } from '../domain/fare';

/**
 * §4.14.4 — the fare table, sourced from configuration.
 *
 * `estimateFare` stays pure and still takes a policy argument, so the domain
 * tests keep asserting against a literal table. This is the one place that
 * turns environment variables into that table, which is what makes the amounts
 * configurable without the domain ever reading process.env.
 */
@Injectable()
export class FarePolicyProvider {
  readonly policy: FarePolicy;

  constructor(config: ConfigService) {
    // The same `get<AppConfig>(APP_CONFIG)!` shape used everywhere else in the
    // codebase, rather than the `{ infer: true }` overload: APP_CONFIG is a plain
    // string token, so `infer` has nothing to infer from and widens every field to
    // `string | number | boolean | string[]`.
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

/**
 * Injection token. A use-case depends on this rather than on the provider, so a
 * test can supply a literal policy without constructing a ConfigService.
 */
export const FARE_POLICY = 'FARE_POLICY';
