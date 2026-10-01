import { add, compare, fromJSON, isZero, money, multiply, toJSON, ZERO } from './money';

describe('money', () => {
  it('stores minor units exactly, with no float involved', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; minor units sidestep that class of bug.
    expect(money('3450').amountMinor).toBe(3450n);
    expect(add(money(10), money(20)).amountMinor).toBe(30n);
  });

  it('refuses to mix currencies rather than silently producing nonsense', () => {
    expect(() => add(money(100, 'USD'), money(100, 'EUR'))).toThrow(/currency mismatch/);
    expect(() => compare(money(100, 'USD'), money(100, 'EUR'))).toThrow(/currency mismatch/);
  });

  it('orders correctly', () => {
    expect(compare(money(100), money(200))).toBe(-1);
    expect(compare(money(200), money(200))).toBe(0);
    expect(compare(money(300), money(200))).toBe(1);
  });

  it('multiplies by an integer factor', () => {
    expect(multiply(money(250), 3).amountMinor).toBe(750n);
  });

  it('round-trips through JSON', () => {
    // The reason toJSON exists: JSON.stringify throws on BigInt, so a mapper that
    // forgot it would 500.
    const original = money(4499, 'GBP');
    const wire = toJSON(original);
    expect(wire).toEqual({ amountMinor: '4499', currency: 'GBP' });
    expect(JSON.stringify(wire)).toBe('{"amountMinor":"4499","currency":"GBP"}');
    expect(fromJSON(wire).amountMinor).toBe(original.amountMinor);
  });

  it('reports zero', () => {
    expect(isZero(ZERO('USD'))).toBe(true);
    expect(isZero(money(1))).toBe(false);
  });

  it('accepts a numeric input from configuration', () => {
    expect(money(1234).amountMinor).toBe(1234n);
  });
});
