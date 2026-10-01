import { assertValidPoint, distanceMetres, isValidCoordinate, PRECISION, round } from './geo-point';

describe('coordinate validation', () => {
  it('accepts a normal point', () => {
    expect(isValidCoordinate(51.5074, -0.1278)).toBe(true);
  });

  it.each([
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('rejects (%s, %s)', (lat, lng) => {
    expect(isValidCoordinate(lat, lng)).toBe(false);
  });

  it('rejects non-numbers', () => {
    expect(isValidCoordinate('51.5', -0.12)).toBe(false);
    expect(isValidCoordinate(null, undefined)).toBe(false);
  });

  it('throws on an invalid point', () => {
    expect(() => assertValidPoint({ lat: 200, lng: 0 })).toThrow(/invalid coordinate/);
    expect(assertValidPoint({ lat: 0, lng: 0 })).toEqual({ lat: 0, lng: 0 });
  });
});

describe('distanceMetres', () => {
  it('is zero for the same point', () => {
    expect(distanceMetres({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0);
  });

  it('matches a known distance', () => {
    // London to Paris is ~344km; the bound is loose because the point is order of
    // magnitude, not geodesic precision.
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const metres = distanceMetres(london, paris);
    expect(metres).toBeGreaterThan(330_000);
    expect(metres).toBeLessThan(360_000);
  });

  it('is symmetric', () => {
    const a = { lat: 51.5, lng: -0.12 };
    const b = { lat: 51.6, lng: -0.02 };
    expect(distanceMetres(a, b)).toBeCloseTo(distanceMetres(b, a), 6);
  });
});

describe('round', () => {
  it('truncates to the storage precision', () => {
    expect(round({ lat: 51.5074123456, lng: -0.1278123456 })).toEqual({
      lat: Number((51.5074123456).toFixed(PRECISION)),
      lng: Number((-0.1278123456).toFixed(PRECISION)),
    });
  });

  it('produces an idempotent result, so cache and row cannot disagree', () => {
    const once = round({ lat: 1.123456789, lng: 2.987654321 });
    expect(round(once)).toEqual(once);
  });
});
