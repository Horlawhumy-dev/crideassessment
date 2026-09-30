import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import { shouldRetry } from '@/lib/api/query-keys';
import { distanceMetres, estimateDurationMs, formatDistance, formatDuration, formatMoney, MoneyFormatError, rideReference } from '@/lib/format';
import { allowedActions, isTerminal, RIDE_STATUS_META } from '@/lib/ride-status';

/**
 * The parts of the app that were wrong in ways a type could not catch.
 *
 * `formatMoney` in particular: the previous app rendered a fare with no currency
 * symbol and no minor-unit handling, so a 10300-kobo fare read as "10300".
 */

describe('formatMoney', () => {
  it('renders minor units as a major-unit amount with a symbol', () => {
    expect(formatMoney({ amountMinor: '10300', currency: 'NGN' })).toBe('₦103.00');
  });

  it('groups thousands', () => {
    expect(formatMoney({ amountMinor: '1250000', currency: 'NGN' })).toBe('₦12,500.00');
  });

  it('renders a zero fare as a real amount, not a dash', () => {
    expect(formatMoney({ amountMinor: '0', currency: 'NGN' })).toBe('₦0.00');
  });

  it('renders a null fare as a dash', () => {
    expect(formatMoney(null)).toBe('—');
  });

  it('handles a negative amount', () => {
    expect(formatMoney({ amountMinor: '-500', currency: 'NGN' })).toBe('-₦5.00');
  });

  /**
   * `amountMinor` is a string end to end — BigInt in the domain, string at the
   * mapper, string on the wire — because a JSON number cannot represent 2^53
   * minor units exactly. A fare that lost its last digits is worse than a
   * parse error, so a malformed amount throws rather than rendering as `NaN`.
   */
  it('throws on an unparseable amount rather than rendering NaN', () => {
    expect(() => formatMoney({ amountMinor: 'not-a-number', currency: 'NGN' })).toThrow(MoneyFormatError);
  });

  it('renders other currencies rather than pretending they are naira', () => {
    expect(formatMoney({ amountMinor: '850', currency: 'USD' })).toBe('$8.50');
  });
});

describe('distance and duration', () => {
  it('matches the backend haversine on a known Osogbo pair', () => {
    // City Mall to OSU is about 1.4 km as the crow flies.
    const metres = distanceMetres({ lat: 7.7714, lng: 4.5489 }, { lat: 7.7833, lng: 4.556 });
    expect(metres).toBeGreaterThan(1200);
    expect(metres).toBeLessThan(1800);
  });

  it('is zero for a point and itself', () => {
    expect(distanceMetres({ lat: 7.77, lng: 4.55 }, { lat: 7.77, lng: 4.55 })).toBe(0);
  });

  it('formats sub-kilometre distances in metres', () => {
    expect(formatDistance(430)).toBe('430 m');
    expect(formatDistance(1_450)).toBe('1.4 km');
  });

  it('refuses to invent a duration from a nonsense input', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });

  it('estimates against the same 30 km/h the server assumes', () => {
    // 3 km at 30 km/h is 6 minutes. The destination is derived from a real
    // 3 km offset rather than a guessed degree count — 0.03° of latitude is
    // 3.34 km, which is the mistake this assertion originally made.
    const origin = { lat: 7.77, lng: 4.55 };
    const metresPerDegreeLat = 111_320;
    const threeKmNorth = { lat: origin.lat + 3000 / metresPerDegreeLat, lng: origin.lng };

    expect(distanceMetres(origin, threeKmNorth)).toBeCloseTo(3000, -2);
    expect(formatDuration(estimateDurationMs(origin, threeKmNorth))).toBe('6 min');
  });
});

describe('rideReference', () => {
  it('never shows a raw uuid', () => {
    expect(rideReference('13327990-3d40-4b93-a0a1-4e341e13e15c')).toBe('#1332');
  });
});

describe('the status vocabulary', () => {
  it('has an entry for every status the contract can produce', () => {
    // The `Record` type enforces this at compile time. The runtime assertion is
    // here so a hand-edited table cannot quietly lose one.
    const statuses = ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
    for (const status of statuses) {
      expect(RIDE_STATUS_META[status]).toBeDefined();
      expect(RIDE_STATUS_META[status].label).toBeTruthy();
    }
  });

  it('describes the five states in words, not in enum values', () => {
    // "Arriving" is not a state. §5.11: the label is a sentence, so no screen
    // can render `status` directly and produce a machine word.
    expect(RIDE_STATUS_META.REQUESTED.label).toBe('Finding a driver');
    expect(RIDE_STATUS_META.ACCEPTED.label).toBe('Driver on the way');
  });

  it('treats COMPLETED and CANCELLED as terminal', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('IN_PROGRESS')).toBe(false);
  });
});

describe('allowedActions', () => {
  /**
   * §4.13. A rider may not cancel once a driver is committed. The old dashboard
   * showed Cancel on an in-progress ride, and the user got a 409 from a button
   * the app had just told them was valid.
   */
  it('lets a rider cancel only before a driver accepts', () => {
    expect(allowedActions('REQUESTED', 'RIDER')).toEqual(['CANCELLED']);
    expect(allowedActions('ACCEPTED', 'RIDER')).toEqual([]);
    expect(allowedActions('IN_PROGRESS', 'RIDER')).toEqual([]);
  });

  it('lets a driver accept a request, then advance it', () => {
    expect(allowedActions('REQUESTED', 'DRIVER')).toEqual(['ACCEPTED', 'CANCELLED']);
    expect(allowedActions('ACCEPTED', 'DRIVER')).toEqual(['IN_PROGRESS', 'CANCELLED']);
    expect(allowedActions('IN_PROGRESS', 'DRIVER')).toEqual(['COMPLETED', 'CANCELLED']);
  });

  /**
   * A driver cancelling their own trip. The rider side of this rule is the one the
   * old dashboard got wrong; the driver side is the one that was simply missing, and
   * it is the more common reason a trip ends early — a vehicle problem the driver
   * could see coming and the rider knew nothing about.
   *
   * Cancellation is not a demotion, so it sits next to the normal actions rather
   * than behind a menu.
   */
  it('lets the assigned driver cancel the ride they are holding', () => {
    expect(allowedActions('ACCEPTED', 'DRIVER')).toContain('CANCELLED');
    expect(allowedActions('IN_PROGRESS', 'DRIVER')).toContain('CANCELLED');
  });

  it('does not let a driver cancel a ride that has already finished', () => {
    expect(allowedActions('COMPLETED', 'DRIVER')).toEqual([]);
    expect(allowedActions('CANCELLED', 'DRIVER')).toEqual([]);
  });

  it('offers nothing from a terminal state', () => {
    expect(allowedActions('COMPLETED', 'DRIVER')).toEqual([]);
    expect(allowedActions('CANCELLED', 'RIDER')).toEqual([]);
  });
});

describe('ApiError', () => {
  const envelope = {
    error: {
      code: 'RIDE_ALREADY_ACCEPTED',
      message: 'This ride was already accepted by another driver.',
      details: null,
      correlationId: '9f1c2b4e-0a1b-4c3d-8e5f-6a7b8c9d0e1f',
      timestamp: '2026-09-30T10:00:00.000Z',
    },
  };

  it('reads the envelope rather than a message string', () => {
    const error = ApiError.from(409, envelope);

    expect(error.code).toBe('RIDE_ALREADY_ACCEPTED');
    expect(error.isConflict).toBe(true);
    expect(error.debugHint).toContain('9f1c2b4e');
  });

  it('treats a 401 as "not signed in" rather than a failure', () => {
    expect(ApiError.from(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } }).isUnauthenticated).toBe(true);
  });

  it('handles a body that is not an envelope at all', () => {
    // A proxy's HTML error page, or a 502 from something in front of the API.
    const error = ApiError.from(502, '<html>Bad Gateway</html>');
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.isTransient).toBe(true);
  });

  it('surfaces validation issues for a form to render', () => {
    const error = ApiError.from(400, {
      error: {
        code: 'MISSING_FIELD',
        message: 'A required field is missing.',
        details: { issues: [{ path: 'pickup.lat', message: 'Number must be less than or equal to 90' }] },
        correlationId: 'c1',
      },
    });

    expect(error.isValidation).toBe(true);
    expect(error.validationIssues[0]?.path).toBe('pickup.lat');
  });

  it('never tells a user their password is wrong when the network is down', () => {
    // The previous auth page collapsed every failure into "Invalid credentials".
    expect(ApiError.network(new Error('fetch failed')).displayMessage).not.toMatch(/password/i);
  });
});

describe('shouldRetry', () => {
  it('retries a network failure', () => {
    expect(shouldRetry(0, ApiError.network(new Error('x')))).toBe(true);
  });

  it('retries a 5xx', () => {
    expect(shouldRetry(0, ApiError.from(500, null))).toBe(true);
  });

  /**
   * A blanket `retry: 3` on every query is why apps hammer a struggling API and
   * still show the wrong thing. A conflict will not resolve itself.
   */
  it('does not retry a conflict', () => {
    expect(shouldRetry(0, ApiError.from(409, null))).toBe(false);
  });

  it('does not retry a version conflict', () => {
    expect(shouldRetry(0, ApiError.from(409, { error: { code: 'RIDE_VERSION_CONFLICT', message: 'x' } }))).toBe(false);
  });

  it('does not retry a rate limit, an auth failure or a validation failure', () => {
    expect(shouldRetry(0, ApiError.from(429, null))).toBe(false);
    expect(shouldRetry(0, ApiError.from(401, null))).toBe(false);
    expect(shouldRetry(0, ApiError.from(400, null))).toBe(false);
  });

  it('gives up after two attempts', () => {
    expect(shouldRetry(2, ApiError.network(new Error('x')))).toBe(false);
  });
});
