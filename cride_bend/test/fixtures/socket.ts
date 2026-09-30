
import { io, type Socket } from 'socket.io-client';
import { ACCESS_COOKIE } from '../../src/common/openapi/cookie-names';

/**
 * A connected Socket.IO client for the /rides namespace.
 *
 * The cookie is set explicitly rather than relying on the client keeping a jar.
 * `SocketAuth` accepts `cride.sid` from the handshake, and passing `extraHeaders`
 * makes the request look exactly like the browser case the cookie decision
 * (§4.8.4) was designed for — the alternative, a token in `auth`, would test a
 * path a browser client can never use.
 */
export interface RideSocket {
  socket: Socket;
  /** Every event received, in order, so a test can assert on what did NOT arrive. */
  received: { event: string; payload: unknown }[];
  /** Resolves on the next occurrence of `event`, or rejects on timeout. */
  waitFor: (event: string, timeoutMs?: number) => Promise<unknown>;
  /** Like waitFor, but only resolves for a payload matching `predicate`. */
  waitForWhere: <T>(event: string, predicate: (payload: T) => boolean, timeoutMs?: number) => Promise<T>;
  /** Resolves true if `event` arrives within the window. Never rejects. */
  saw: (event: string, withinMs: number) => Promise<boolean>;
  disconnect: () => Promise<void>;
}

const DEFAULT_TIMEOUT = 5_000;

export async function connectRideSocket(
  url: string,
  accessToken: string,
  options: { cookie?: string; withCredentials?: boolean } = {},
): Promise<RideSocket> {
  const socket = io(`${url}/rides`, {
    transports: ['websocket'],
    // The Redis adapter is in play, so allow polling as a fallback if the upgrade
    // is refused; the tests should fail on behaviour, not on transport.
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: options.cookie ?? `${ACCESS_COOKIE}=${accessToken}` },
  });

  const received: { event: string; payload: unknown }[] = [];
  const waiters: { event: string; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  // Predicate-based waiters, run against every tracked event as it arrives.
  const matchers: ((payload: unknown) => void)[] = [];

  // Recorded rather than awaited, so a test can assert that an event a principal
  // is not entitled to never arrived. A `waitFor` that rejects is the only way to
  // prove absence, but it cannot also be used to collect the events that did.
  //
  // These are the names RealtimeHandler actually publishes, not guesses:
  // `ride:status_changed` for every state change, `ride:assigned` for the
  // accept-specific one, `ride:offer` for the driver broadcast and
  // `ride:released` when a driver is dropped. The outbox event types
  // (`ride.accepted`, `ride.started`, …) are internal and never reach a client.
  const TRACKED = [
    'ride:status_changed',
    'ride:assigned',
    'ride:offer',
    'ride:released',
    'ride:driver_location_update',
    'ride:updated',
  ];
  for (const event of TRACKED) {
    socket.on(event, (payload: unknown) => {
      received.push({ event, payload });
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]?.event === event) waiters.splice(i, 1)[0]?.resolve(payload);
      }
      for (const match of [...matchers]) match(payload);
    });
  }

  await waitForConnect(socket);

  /**
   * Named rather than an inline closure using `this`. Inside an object literal
   * returned from an `async` function, `this` is typed as the object *or* the
   * promise it will resolve to, so `this.waitFor` does not typecheck. A named
   * function is also honest about what it does — `saw` is "wait, swallow the
   * timeout", not a second kind of wait.
   */
  const waitFor = (event: string, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> => {
    const already = received.find((r) => r.event === event);
    if (already) return Promise.resolve(already.payload);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`));
      }, timeoutMs);
      waiters.push({
        event,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  };

  const saw = async (event: string, withinMs: number): Promise<boolean> => {
    try {
      await waitFor(event, withinMs);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Waits for an occurrence of `event` that satisfies `predicate`.
   *
   * Needed because the same event name is published for every state change, so
   * `waitFor('ride:status_changed')` can hand back the `REQUESTED` publish that
   * landed after the client joined rather than the `ACCEPTED` one the test is
   * about. Matching the first event of a name would make the test pass or fail
   * depending on whether the 250ms relay poll beat the socket join.
   */
  const waitForWhere = <T>(
    event: string,
    predicate: (payload: T) => boolean,
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<T> => {
    const seen = received.filter((r) => r.event === event).map((r) => r.payload as T);
    const already = seen.find(predicate);
    if (already !== undefined) return Promise.resolve(already);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching "${event}"`)),
        timeoutMs,
      );
      const check = (payload: unknown) => {
        if (predicate(payload as T)) {
          clearTimeout(timer);
          remove();
          resolve(payload as T);
        }
      };
      const remove = () => {
        const i = matchers.indexOf(check);
        if (i !== -1) matchers.splice(i, 1);
      };
      matchers.push(check);
    });
  };

  return {
    socket,
    received,
    waitFor,
    saw,
    waitForWhere,
    async disconnect() {
      socket.removeAllListeners();
      matchers.length = 0;
      socket.disconnect();
    },
  };
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect')), DEFAULT_TIMEOUT);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * `emitWithAck` with a deadline.
 *
 * Socket.IO does not reply to a message whose handler threw — the exception is
 * logged server-side and the client is simply left waiting. That is correct
 * socket.io behaviour and it is not what a test should assert against directly:
 * `await socket.emitWithAck(...)` on a rejected handler never settles, so the
 * test burns its whole jest timeout (60s by default) and reports "Exceeded
 * timeout" with no indication that a 403 was the expected answer.
 *
 * A deadline turns that into a fast, legible failure. Tests assert the *absence* of
 * an ack — which is the observable proof the server refused — rather than waiting
 * forever to be told so.
 */
export async function ack<T = unknown>(
  socket: Socket,
  event: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ack for "${event}" within ${timeoutMs}ms`)),
      timeoutMs,
    );
    // Do not let the rejection timer keep the event loop alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([socket.emitWithAck(event, body) as Promise<T>, timeout]);
}
