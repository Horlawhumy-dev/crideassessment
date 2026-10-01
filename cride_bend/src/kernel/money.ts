/** Money as integer minor units (3450 = 34.50). BigInt, not a Decimal column: `JSON.stringify`
 *  throws on BigInt, so the string conversion happens exactly once, in `toJSON`. */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export const ZERO = (currency: string): Money => ({ amountMinor: 0n, currency });

export function money(amountMinor: bigint | number | string, currency = 'USD'): Money {
  return { amountMinor: BigInt(amountMinor), currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function multiply(m: Money, factor: bigint | number): Money {
  return { amountMinor: m.amountMinor * BigInt(factor), currency: m.currency };
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0n;
}

export function isNegative(m: Money): boolean {
  return m.amountMinor < 0n;
}

/** JSON-safe projection. The single point where a Money becomes a string. */
export function toJSON(m: Money): { amountMinor: string; currency: string } {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}

export function fromJSON(v: { amountMinor: string; currency: string }): Money {
  return { amountMinor: BigInt(v.amountMinor), currency: v.currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
