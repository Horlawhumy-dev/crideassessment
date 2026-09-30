/**
 * The transaction boundary as a port, so the application layer needs "run these
 * steps atomically", not an ORM. `tx` is opaque, so a use-case physically cannot
 * run a query — which is what keeps reads for disambiguation after the write.
 */
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
