/** The transaction boundary as a port, so the application layer asks for "run these steps
 *  atomically", not for an ORM. `tx` is opaque, so a use-case cannot query on its own. */
export type TransactionContext = unknown;

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

export interface TransactionRunner {
  /** Runs `fn` in one transaction; nested calls join the outer one, not a second. */
  run<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface TxLike {
  // Deliberately empty: PrismaClient is known to infrastructure, not application;
  // the cast happens once, inside each adapter.
  readonly __txBrand?: never;
}
