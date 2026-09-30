import type request from 'supertest';

/**
 * A supertest agent — the type of `request(url)`.
 *
 * Helpers take this directly and callers write `ctx.http()`. The call is not
 * boilerplate: a fresh agent per call is the point. A supertest agent accumulates
 * cookies, and this suite authenticates dozens of riders and drivers against one
 * server. A single shared jar would let rider A's `cride.sid` ride along on
 * driver B's request, silently defeating every authorization assertion that
 * follows. A new agent per call makes cross-actor cookie bleed impossible by
 * construction rather than by remembering to be careful.
 *
 * Named `request.Agent`, not `request.SuperTest`. The latter exists in the typings
 * as an alias for `superagent.SuperAgent`, but `request(url)` actually returns the
 * `TestAgent` class in `@types/supertest/lib/agent`, and the two do not
 * structurally agree. Deriving the type from the call expression instead of
 * trusting the alias is what keeps this honest across @types upgrades.
 */
export type Http = request.Agent;

/** The factory held on TestApp, returning a fresh cookie jar each time. */
export type HttpFactory = () => Http;
