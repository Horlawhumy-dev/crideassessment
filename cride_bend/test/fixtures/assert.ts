/**
 * Assertion helpers that narrow types as a side effect.
 *
 * The project runs `noUncheckedIndexedAccess`, so `winners[0]` is `T | undefined`
 * even immediately after `expect(winners).toHaveLength(1)` — jest's matcher does
 * not narrow for the compiler. The usual workarounds are `winners[0]!` or a
 * cast, and both are strictly worse here: they assert the shape to the compiler
 * while asserting nothing to the reader, and a `.!` on a genuinely empty array
 * produces `Cannot read properties of undefined` instead of the diff the test
 * author needed to see.
 *
 * These functions check at runtime and return a non-optional value, so the
 * compiler and the test agree about what is true.
 */

/** Exactly one element, or a readable failure. */
export function one<T>(items: T[], label = 'expected exactly one item'): T {
  if (items.length !== 1) {
    throw new Error(`${label}: got ${items.length}\n${JSON.stringify(items, null, 2).slice(0, 2000)}`);
  }
  return items[0] as T;
}

/** At least one element, or a readable failure. */
export function first<T>(items: T[], label = 'expected at least one item'): T {
  if (items.length === 0) {
    throw new Error(`${label}: got 0`);
  }
  return items[0] as T;
}
