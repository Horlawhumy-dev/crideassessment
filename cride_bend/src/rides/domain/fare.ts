import { distanceMetres, type GeoPoint } from '../../kernel/geo-point';
import { money, multiply, add, type Money } from '../../kernel/money';
import { DomainError } from '../../common/errors/domain-error';

/** Pure fare table; the policy is passed in so the domain never reads configuration. */
export interface FarePolicy {
  readonly baseFareMinor: bigint;
  readonly perKmMinor: bigint;
  readonly perMinuteMinor: bigint;
  readonly minimumFareMinor: bigint;
  readonly currency: string;
}

export const DEFAULT_FARE_POLICY: FarePolicy = {
  baseFareMinor: 250n,
  perKmMinor: 120n,
  perMinuteMinor: 25n,
  minimumFareMinor: 500n,
  currency: 'USD',
};

export const AVERAGE_SPEED_KPH = 30;

export interface FareInput {
  readonly pickup: GeoPoint;
  readonly dropoff: GeoPoint;
  readonly durationMs: number;
}

export function estimateFare(
  input: FareInput,
  policy: FarePolicy = DEFAULT_FARE_POLICY,
): Money {
  const metres = distanceMetres(input.pickup, input.dropoff);

  if (!Number.isFinite(metres) || metres < 0) {
    throw new DomainError('FARE_NOT_COMPUTABLE', undefined, { metres });
  }

  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new DomainError('FARE_NOT_COMPUTABLE', undefined, {
      durationMs: input.durationMs,
    });
  }

  const km = Math.round(metres / 100) / 10; // 100m granularity
  const minutes = Math.round(input.durationMs / 60_000);

  const total = add(
    add(money(policy.baseFareMinor, policy.currency), multiply(money(policy.perKmMinor, policy.currency), BigInt(Math.ceil(km * 10)))),
    multiply(money(policy.perMinuteMinor, policy.currency), BigInt(minutes)),
  );

  return total.amountMinor < policy.minimumFareMinor
    ? money(policy.minimumFareMinor, policy.currency)
    : total;
}

export function estimateDurationMs(
  pickup: GeoPoint,
  dropoff: GeoPoint,
): number {
  const metres = distanceMetres(pickup, dropoff);
  return Math.round((metres / 1000 / AVERAGE_SPEED_KPH) * 3_600_000);
}
