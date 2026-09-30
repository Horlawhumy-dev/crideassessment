import { NextResponse } from 'next/server';

/**
 * The BFF. §5.13.
 *
 * Why this file exists at all, when a proxy would be three lines:
 *
 * The API authenticates with two HttpOnly cookies, `cride.sid` and
 * `cride.refresh`, set on the API's own origin. A browser will not attach a
 * cookie to a cross-origin request to a different host, and JavaScript cannot
 * read an HttpOnly cookie at all. So a client-side `fetch('http://localhost:4000')
 * ` cannot authenticate — not with `credentials: 'include'`, not with anything.
 * There is no workaround, because the restriction is the point of HttpOnly.
 *
 * So every API call from the browser goes to this app's own origin, and this
 * handler forwards it server-side, where the cookie can be read, and hands back
 * the Set-Cookie verbatim so a refreshed session sticks.
 *
 * The rules this file has to get right, each of which is a way to break auth:
 *
 * - Forward the `cookie` header in, or the API sees an anonymous caller.
 * - Use `headers.getSetCookie()` and `append` each one back. `headers.get('set-cookie')`
 *   returns one comma-joined string, which corrupts `Expires=Wed, 01 Oct 2026 …`
 *   and merges two sessions into one malformed cookie — and so does re-joining
 *   the array with `', '`. `Set-Cookie` is the one header that is *not* a
 *   comma-separated list; each cookie is its own header field.
 * - Reject cross-origin mutations, or every unsafe verb on this proxy is an
 *   unauthenticated CSRF target (§ below).
 * - Do not cache. A `Cache-Control` header on `/auth/me` is a shared session.
 * - Do not add a prefix. The API has no global prefix, and a `/api/v1` here
 *   becomes a 404 the moment the backend mounts a new route.
 */

const API_ORIGIN = process.env.API_URL ?? 'http://localhost:4000';

/** Routes that must never be cached, regardless of what the API sent. */
const NO_STORE = 'no-store, no-cache, must-revalidate, private';

function resolveUpstream(segments: string[]): URL {
  // Re-encoded per segment: a ride id is a uuid, but a path assembled by string
  // concatenation is one unescaped character away from a request to the wrong
  // route, and the failure would be a confusing 404 rather than an error.
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(`/${path}`, API_ORIGIN);
}

/**
 * Headers worth forwarding. The rest are hop-by-hop, and forwarding `host` or
 * `connection` produces a request the API cannot route.
 */
const FORWARD_REQUEST_HEADERS = ['cookie', 'content-type', 'accept', 'accept-language', 'x-request-id'] as const;

/**
 * Only these verbs are proxied. Exporting a handler for a verb is an opt-in, and
 * an allowlist keeps the proxy from becoming a general-purpose relay for whatever
 * a new upstream route happens to expose: `PUT` and `HEAD` were exported against
 * no documented API route at all.
 */
const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the mutating verbs.
 *
 * The session lives in a `SameSite=Lax` cookie, which already blocks the classic
 * cross-site POST — but `Lax` is one line of config in the API, and the cost of
 * this being the *only* defence is that a `SameSite=None` for a future embedded
 * client silently turns every write endpoint into a CSRF target. So the BFF
 * checks provenance itself rather than inferring it:
 *
 *  - `Sec-Fetch-Site`, when present, must be same-origin/same-site/none. Modern
 *    browsers set it on every request and it is not forgeable from a page.
 *  - `Origin` must match this app's own origin when present. This is what
 *    actually catches the attack in the browsers that send it.
 *  - Neither header present means a non-browser client (curl, the API's own
 *    tests, a server-side caller). Those do not have an ambient cookie to abuse,
 *    so they are allowed through.
 *
 * A rejection is 403 with the same error envelope as everything else, because a
 * CSRF response that looks different from an API response is a response that
 * tells an attacker they hit a real endpoint.
 */
function isCrossSite(request: Request, ownOrigin: string): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') return true;

  const origin = request.headers.get('origin');
  if (origin && origin !== ownOrigin && origin !== 'null') return true;

  return false;
}

function forbidden(details: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'FORBIDDEN',
        message: 'Cross-origin request rejected.',
        details,
        correlationId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      },
    },
    { status: 403, headers: { 'cache-control': NO_STORE } },
  );
}

async function proxy(request: Request, path: string[]): Promise<Response> {
  if (!(ALLOWED_METHODS as readonly string[]).includes(request.method)) {
    return NextResponse.json(
      {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `This proxy does not forward ${request.method}.`,
          details: { allowed: ALLOWED_METHODS },
          correlationId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        },
      },
      { status: 405, headers: { allow: ALLOWED_METHODS.join(', '), 'cache-control': NO_STORE } },
    );
  }

  if (!CSRF_SAFE_METHODS.has(request.method) && isCrossSite(request, new URL(request.url).origin)) {
    return forbidden({
      method: request.method,
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
    });
  }

  const url = resolveUpstream(path);
  const incoming = new URL(request.url);

  // Query string: the cursor and limit on every list endpoint live here.
  incoming.searchParams.forEach((value, key) => url.searchParams.append(key, value));

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // DELETE and PATCH can carry a body. `new Request` with a GET/HEAD would
  // throw, so the body is only attached when there is one.
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (cause) {
    // §4.14: DATABASE_UNAVAILABLE and CACHE_UNAVAILABLE come back as the *other*
    // status with this code inside. A dead origin gets the same shape here, so
    // the client has exactly one error contract to handle.
    return NextResponse.json(
      {
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Cannot reach the C-Ride API.',
          details: { upstream: API_ORIGIN, reason: cause instanceof Error ? cause.message : String(cause) },
          correlationId: request.headers.get('x-request-id') ?? crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        },
      },
      { status: 502, headers: { 'cache-control': NO_STORE } },
    );
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) responseHeaders.set('content-type', contentType);

  const correlationId = upstream.headers.get('x-request-id');
  if (correlationId) responseHeaders.set('x-request-id', correlationId);

  // The one line the whole session depends on. Appended one at a time: joining
  // them with ', ' is the same corruption as `headers.get('set-cookie')`, because
  // `Expires=Wed, 01 Oct 2026 …` contains a comma of its own.
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  responseHeaders.set('cache-control', NO_STORE);

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type Context = { params: Promise<Record<string, string[]>> };

export const GET = (request: Request, context: Context) => withParams(request, context, proxy);
export const POST = (request: Request, context: Context) => withParams(request, context, proxy);
export const PATCH = (request: Request, context: Context) => withParams(request, context, proxy);
export const DELETE = (request: Request, context: Context) => withParams(request, context, proxy);

async function withParams(
  request: Request,
  context: Context,
  handler: (request: Request, path: string[]) => Promise<Response>,
): Promise<Response> {
  const { path } = await context.params;
  return handler(request, path ?? []);
}

/** Nothing is cached here. §5.15. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
