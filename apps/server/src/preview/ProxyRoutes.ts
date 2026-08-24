/**
 * Preview proxy routes - the HTTP surface of the remote dev-server preview.
 *
 * Three pieces:
 *
 * - An entry route that exchanges a single-use ticket (minted over the
 *   authenticated WebSocket) for an HttpOnly session cookie and redirects
 *   into the proxied origin.
 * - An exit route that clears the cookie when the client closes the preview.
 * - A global middleware that, for requests carrying a valid session cookie,
 *   proxies the whole origin - documents, root-relative assets, fetch
 *   requests, and WebSocket upgrades (HMR) - to the validated host-local
 *   port. Requests that present T3 credentials (Authorization header or a
 *   wsTicket query param) and a small set of reserved T3 paths always bypass
 *   the proxy, because on Android the app's own fetches share the WebView
 *   cookie jar.
 *
 * T3 credentials never reach the dev server: proxied requests are exactly the
 * ones without credential headers, and T3 cookies are stripped from the
 * forwarded Cookie header.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Cookies from "effect/unstable/http/Cookies";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Socket from "effect/unstable/socket/Socket";

import { WEBSOCKET_TICKET_QUERY_PARAM } from "../auth/EnvironmentAuth.ts";
import {
  PREVIEW_PROXY_COOKIE_NAME,
  PREVIEW_PROXY_ENTRY_PREFIX,
  PREVIEW_PROXY_EXIT_PATH,
  PREVIEW_PROXY_ROUTE_PREFIX,
  redeemEntryTicket,
  verifySessionCookie,
  type ProxySessionClaims,
} from "./ProxyAccess.ts";

/**
 * Paths that must keep working while a preview cookie is set. `/api/preview`
 * is the proxy's own control surface, `/api/assets` carries signed asset URLs
 * the app renders without credentials, and `/.well-known/t3` is the
 * unauthenticated connection probe.
 */
const PREVIEW_PROXY_BYPASS_PREFIXES = [
  `${PREVIEW_PROXY_ROUTE_PREFIX}/`,
  "/api/assets/",
  "/.well-known/t3/",
] as const;

/** T3 cookies stay on the T3 origin; everything else forwards to the dev server. */
const isReservedCookieName = (name: string) =>
  name === PREVIEW_PROXY_COOKIE_NAME || name.startsWith("t3_session");

/**
 * Pure routing decision: true when the request must be handled by T3 itself
 * even though a preview cookie may be present.
 */
export function shouldBypassPreviewProxy(input: {
  readonly path: string;
  readonly hasAuthorizationHeader: boolean;
  readonly hasWsTicketParam: boolean;
}): boolean {
  if (input.hasAuthorizationHeader || input.hasWsTicketParam) return true;
  if (input.path === PREVIEW_PROXY_ROUTE_PREFIX) return true;
  return PREVIEW_PROXY_BYPASS_PREFIXES.some((prefix) => input.path.startsWith(prefix));
}

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "proxy-authorization",
  "proxy-connection",
  // Credentials must never reach the dev server.
  "authorization",
  "dpop",
  // fetch negotiates its own encoding and decompresses transparently.
  "accept-encoding",
  // The body is re-streamed; fetch recomputes framing.
  "content-length",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  // fetch already decompressed the body; the compression middleware
  // re-encodes for the client if it wants to.
  "content-encoding",
  "content-length",
]);

/** Strip T3 cookies from a Cookie header, preserving the dev server's own. */
export function filterForwardedCookieHeader(cookieHeader: string): string | null {
  const kept = cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair.length === 0) return false;
      const name = pair.slice(0, pair.indexOf("=") === -1 ? pair.length : pair.indexOf("="));
      return !isReservedCookieName(name.trim());
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

/** Drop upstream Set-Cookie values that would clobber T3's own cookies. */
export function isForwardableSetCookie(value: string): boolean {
  const separator = value.indexOf("=");
  if (separator <= 0) return false;
  return !isReservedCookieName(value.slice(0, separator).trim());
}

export function filterForwardedRequestHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
    if (lower === "cookie") {
      const filtered = filterForwardedCookieHeader(value);
      if (filtered !== null) forwarded[lower] = filtered;
      continue;
    }
    forwarded[lower] = value;
  }
  return forwarded;
}

function upstreamAuthority(claims: ProxySessionClaims): string {
  const host = claims.host.includes(":") ? `[${claims.host}]` : claims.host;
  return `${host}:${claims.port}`;
}

const previewCookieOptions = {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
} as const;

const setPreviewCookie = (value: string, expiresAtEpochMillis: number) =>
  Effect.fromResult(
    Cookies.set(Cookies.empty, PREVIEW_PROXY_COOKIE_NAME, value, {
      ...previewCookieOptions,
      expires: DateTime.toDate(DateTime.makeUnsafe(expiresAtEpochMillis)),
    }),
  );

const clearPreviewCookieResponse = (response: HttpServerResponse.HttpServerResponse) =>
  setPreviewCookie("", 0).pipe(
    Effect.map((cookies) => HttpServerResponse.mergeCookies(response, cookies)),
    Effect.orElseSucceed(() => response),
  );

const failurePage = (status: number, message: string) =>
  HttpServerResponse.text(message, { status, headers: { "cache-control": "no-store" } });

function resolveEntryRedirectTarget(search: URLSearchParams): string {
  const target = search.get("to");
  if (!target || !target.startsWith("/") || target.startsWith("//")) return "/";
  return target;
}

/** GET /api/preview/enter/<ticket>?to=/path - redeem a ticket, set the cookie, enter the origin. */
export const previewProxyEntryRouteLayer = HttpRouter.add(
  "GET",
  `${PREVIEW_PROXY_ENTRY_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const token = url.value.pathname.slice(`${PREVIEW_PROXY_ENTRY_PREFIX}/`.length);
    const redemption = yield* redeemEntryTicket(token);
    if (!redemption.ok) {
      return yield* clearPreviewCookieResponse(
        failurePage(403, `Preview ticket rejected (${redemption.reason}).`),
      );
    }
    const cookies = yield* setPreviewCookie(
      redemption.cookieValue,
      redemption.claims.expiresAt,
    ).pipe(Effect.orElseSucceed(() => Cookies.empty));
    return HttpServerResponse.mergeCookies(
      HttpServerResponse.redirect(resolveEntryRedirectTarget(url.value.searchParams), {
        status: 302,
        headers: { "cache-control": "no-store" },
      }),
      cookies,
    );
  }),
);

/** GET /api/preview/exit - clear the preview session cookie. */
export const previewProxyExitRouteLayer = HttpRouter.add(
  "GET",
  PREVIEW_PROXY_EXIT_PATH,
  clearPreviewCookieResponse(HttpServerResponse.empty({ status: 204 })),
);

const proxyHttpRequest = (
  claims: ProxySessionClaims,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const target = `http://${upstreamAuthority(claims)}${url.pathname}${url.search}`;
    const headers = filterForwardedRequestHeaders(request.headers);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstreamRequest = HttpClientRequest.make(request.method)(target, { headers }).pipe(
      hasBody ? HttpClientRequest.bodyStream(request.stream) : (self) => self,
    );
    const response = yield* httpClient.execute(upstreamRequest).pipe(
      // Redirects belong to the WebView, not the proxy.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );

    const responseHeaders: Record<string, string | Array<string>> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
      if (lower === "set-cookie") {
        const values = (Array.isArray(value) ? value : [value]).filter(isForwardableSetCookie);
        if (values.length > 0) responseHeaders[lower] = values;
        continue;
      }
      responseHeaders[lower] = value;
    }

    if (response.status === 204 || response.status === 304) {
      return HttpServerResponse.empty({
        status: response.status,
        headers: Headers.fromInput(responseHeaders),
      });
    }
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers: Headers.fromInput(responseHeaders),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Preview proxy upstream request failed", { cause }).pipe(
        Effect.as(
          failurePage(
            502,
            `The previewed dev server is unreachable (${upstreamAuthority(claims)}).`,
          ),
        ),
      ),
    ),
  );

const globalWebSocketConstructor: (typeof Socket.WebSocketConstructor)["Service"] = (
  url,
  protocols,
) => new globalThis.WebSocket(url, protocols);

const proxyWebSocketUpgrade = (
  claims: ProxySessionClaims,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const target = `ws://${upstreamAuthority(claims)}${url.pathname}${url.search}`;
    const protocolHeader = request.headers["sec-websocket-protocol"];
    const protocols =
      typeof protocolHeader === "string"
        ? protocolHeader
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : undefined;
    const clientSocket = yield* request.upgrade;
    const upstreamSocket = yield* Socket.makeWebSocket(target, {
      ...(protocols && protocols.length > 0 ? { protocols } : {}),
      openTimeout: "5 seconds",
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const writeToClient = yield* clientSocket.writer;
        const writeToUpstream = yield* upstreamSocket.writer;
        // Frames pump in both directions until either side closes; the race
        // interrupts the surviving side and scope closure shuts both sockets.
        yield* Effect.raceFirst(
          clientSocket.runRaw((data) => writeToUpstream(data)),
          upstreamSocket.runRaw((data) => writeToClient(data)),
        );
      }),
    ).pipe(Effect.catchIf(Socket.isSocketError, () => Effect.void));
    return HttpServerResponse.empty();
  }).pipe(
    Effect.provideService(Socket.WebSocketConstructor, globalWebSocketConstructor),
    Effect.catchCause((cause) =>
      Effect.logDebug("Preview proxy websocket relay failed", { cause }).pipe(
        Effect.as(failurePage(502, "The previewed dev server websocket is unreachable.")),
      ),
    ),
  );

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["upgrade"]?.toLowerCase() === "websocket";

/**
 * Global middleware: requests carrying a valid preview session cookie are
 * proxied to the pinned host-local port; everything else falls through to the
 * regular router.
 */
export const previewProxyMiddlewareLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const cookieValue = request.cookies[PREVIEW_PROXY_COOKIE_NAME];
      if (cookieValue === undefined) {
        return yield* httpEffect;
      }
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) {
        return yield* httpEffect;
      }
      if (
        shouldBypassPreviewProxy({
          path: url.value.pathname,
          hasAuthorizationHeader: typeof request.headers["authorization"] === "string",
          hasWsTicketParam: url.value.searchParams.has(WEBSOCKET_TICKET_QUERY_PARAM),
        })
      ) {
        return yield* httpEffect;
      }
      const claims = yield* verifySessionCookie(cookieValue);
      if (claims === null) {
        // Expired or foreign cookie: clear it so the next request heals, and
        // report the failure instead of silently showing the T3 app.
        return yield* clearPreviewCookieResponse(
          failurePage(403, "Preview session expired. Close and reopen the preview."),
        );
      }
      return yield* isWebSocketUpgrade(request)
        ? proxyWebSocketUpgrade(claims, request, url.value)
        : proxyHttpRequest(claims, request, url.value);
    }),
  { global: true },
);
