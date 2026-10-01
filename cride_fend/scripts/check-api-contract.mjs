#!/usr/bin/env node
/**
 * CI entry point for the generated-contract check.
 *
 * This used to be `export { check, generate } from './generate-api-types.mjs'`,
 * which is a re-export and not an entry point: importing the module runs its
 * top-level `if (mode === 'check')` with `process.argv[2] === undefined`, so the
 * `generate()` branch ran instead. `npm run check:api` silently *wrote* the
 * committed types instead of verifying them, and always passed — the one check
 * that was supposed to fail on contract drift could not fail.
 *
 * Both modes are now invoked explicitly, so the argv parsing in
 * generate-api-types.mjs is no longer load-bearing here.
 */
import { check } from './generate-api-types.mjs';

try {
  await check();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
