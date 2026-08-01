import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  Cookies,
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  UrlParams,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as SessionStore from "../auth/SessionStore.ts";
import {
  LIVE_GATEWAY_BOOTSTRAP_PREFIX,
  LIVE_GATEWAY_COOKIE_NAME,
  LIVE_GATEWAY_HTTP_COOKIE_NAME,
  type LiveGatewayLease,
  PreviewLiveGateway,
} from "./LiveGateway.ts";

const UPSTREAM_CONNECT_TIMEOUT = Duration.seconds(10);
const BOOTSTRAP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const LIVE_GATEWAY_EXPIRED_STATUS = 511;
export const LIVE_GATEWAY_WEBSOCKET_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_FRAMES = 64;
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;
const PRIVATE_REQUEST_HEADERS = new Set([...HOP_BY_HOP_HEADERS, "authorization", "dpop", "host"]);

const bootstrapResponseHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export function isLiveGatewayControlCookie(
  name: string,
  environmentSessionCookieName: string,
): boolean {
  return (
    name === LIVE_GATEWAY_COOKIE_NAME ||
    name === LIVE_GATEWAY_HTTP_COOKIE_NAME ||
    name === environmentSessionCookieName ||
    name === "t3_session" ||
    name.startsWith("t3_session_")
  );
}

export function liveGatewayCookieName(requestUrl: URL): string {
  return requestUrl.protocol === "https:"
    ? LIVE_GATEWAY_COOKIE_NAME
    : LIVE_GATEWAY_HTTP_COOKIE_NAME;
}

function requestOrigin(requestUrl: URL): string {
  return requestUrl.origin;
}

function proxyCookieHeader(
  request: HttpServerRequest.HttpServerRequest,
  environmentSessionCookieName: string,
): string | undefined {
  const cookies: Cookies.Cookie[] = [];
  for (const [name, value] of Object.entries(request.cookies)) {
    if (isLiveGatewayControlCookie(name, environmentSessionCookieName)) continue;
    try {
      cookies.push(Cookies.makeCookieUnsafe(name, value));
    } catch {
      // An invalid application cookie must not make the gateway unusable.
    }
  }
  const header = Cookies.toCookieHeader(Cookies.fromIterable(cookies));
  return header.length > 0 ? header : undefined;
}

export function liveGatewayUpstreamHeaders(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly requestUrl: URL;
  readonly upstreamUrl: URL;
  readonly environmentSessionCookieName: string;
}): Headers.Headers {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.request.headers)) {
    if (
      PRIVATE_REQUEST_HEADERS.has(name) ||
      name === "cookie" ||
      name === "forwarded" ||
      name.startsWith("cf-") ||
      name.startsWith("sec-websocket-") ||
      name.startsWith("x-forwarded-")
    ) {
      continue;
    }
    forwarded[name] = value;
  }
  forwarded.host = input.upstreamUrl.host;
  forwarded["accept-encoding"] = "identity";
  const cookie = proxyCookieHeader(input.request, input.environmentSessionCookieName);
  if (cookie !== undefined) forwarded.cookie = cookie;
  if (input.request.headers.origin !== undefined) {
    forwarded.origin = input.upstreamUrl.origin;
  }
  if (input.request.headers.referer !== undefined) {
    try {
      const referer = new URL(input.request.headers.referer);
      forwarded.referer = new URL(
        `${referer.pathname}${referer.search}${referer.hash}`,
        input.upstreamUrl.origin,
      ).toString();
    } catch {
      // Drop malformed referrers instead of forwarding the gateway origin.
    }
  }
  return Headers.fromInput(forwarded);
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function isEquivalentUpstreamOrigin(candidate: URL, upstream: URL): boolean {
  return (
    candidate.protocol === upstream.protocol &&
    effectivePort(candidate) === effectivePort(upstream) &&
    isLoopbackHost(candidate.hostname) &&
    isLoopbackHost(upstream.hostname)
  );
}

function rewriteLocation(location: string | undefined, upstreamOrigin: string): string | undefined {
  if (!location) return undefined;
  try {
    const resolved = new URL(location, upstreamOrigin);
    const upstream = new URL(upstreamOrigin);
    return resolved.origin === upstream.origin || isEquivalentUpstreamOrigin(resolved, upstream)
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : resolved.toString();
  } catch {
    return undefined;
  }
}

export function liveGatewayResponseHeaders(input: {
  readonly headers: Headers.Headers;
  readonly requestUrl: URL;
  readonly upstreamOrigin: string;
}): Headers.Headers {
  let headers = Headers.removeMany(input.headers, [
    ...HOP_BY_HOP_HEADERS,
    "set-cookie",
    "content-encoding",
    "content-length",
  ]);
  const location = rewriteLocation(headers.location, input.upstreamOrigin);
  headers =
    location === undefined
      ? Headers.remove(headers, "location")
      : Headers.set(headers, "location", location);
  if (headers["access-control-allow-origin"] === input.upstreamOrigin) {
    headers = Headers.set(headers, "access-control-allow-origin", requestOrigin(input.requestUrl));
  }
  return headers;
}

export function liveGatewayResponseCookies(
  upstream: Cookies.Cookies,
  environmentSessionCookieName: string,
): Cookies.Cookies {
  const cookies: Cookies.Cookie[] = [];
  for (const cookie of Object.values(upstream.cookies)) {
    if (isLiveGatewayControlCookie(cookie.name, environmentSessionCookieName)) continue;
    try {
      cookies.push(
        Cookies.makeCookieUnsafe(cookie.name, cookie.value, {
          ...cookie.options,
          domain: undefined,
        }),
      );
    } catch {
      // Invalid upstream cookies are ignored at this trust boundary.
    }
  }
  return Cookies.fromIterable(cookies);
}

export function liveGatewayUpstreamUrl(requestUrl: URL, lease: LiveGatewayLease): URL {
  const upstreamUrl = new URL(lease.target.origin);
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;
  return upstreamUrl;
}

export function retargetLiveGatewayRequest(
  request: HttpClientRequest.HttpClientRequest,
  upstreamUrl: URL,
  headers: Headers.Headers,
): HttpClientRequest.HttpClientRequest {
  // Keep the query in the raw URL: Vite distinguishes flag queries such as
  // `?url` from their URLSearchParams-normalized form, `?url=`.
  return HttpClientRequest.makeWith(
    request.method,
    upstreamUrl.toString(),
    UrlParams.empty,
    request.hash,
    headers,
    request.body,
  );
}

type LiveGatewaySocketFrame = string | Uint8Array | Socket.CloseEvent;

interface BufferedLiveGatewaySocketFrame {
  readonly frame: LiveGatewaySocketFrame;
  readonly byteLength: number;
}

export function liveGatewayWebSocketProtocols(header: string | undefined): string | undefined {
  const first = header
    ?.split(",")
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.length > 0);
  return first;
}

export function isForwardableWebSocketCloseCode(code: number): boolean {
  return (
    (code >= 1_000 && code <= 1_014 && code !== 1_004 && code !== 1_005 && code !== 1_006) ||
    (code >= 3_000 && code <= 4_999)
  );
}

function forwardedCloseEvent(error: Socket.SocketError): Socket.CloseEvent {
  if (
    error.reason._tag === "SocketCloseError" &&
    isForwardableWebSocketCloseCode(error.reason.code)
  ) {
    return new Socket.CloseEvent(error.reason.code, error.reason.closeReason);
  }
  return new Socket.CloseEvent(1_011, "Live preview websocket peer disconnected");
}

function liveGatewaySocketFrameByteLength(frame: string | Uint8Array): number {
  // UTF-8 needs at most three bytes per JavaScript code unit. This deliberately
  // overestimates surrogate pairs so the pending-byte bound stays conservative
  // without allocating another encoded copy of every text frame.
  return typeof frame === "string" ? frame.length * 3 : frame.byteLength;
}

const closeSocketPair = Effect.fn("PreviewLiveGatewayHttp.closeSocketPair")(function* (
  left: Socket.Socket,
  right: Socket.Socket,
  close: Socket.CloseEvent,
) {
  const [writeLeft, writeRight] = yield* Effect.all([left.writer, right.writer], {
    concurrency: 2,
  });
  yield* Effect.all([writeLeft(close), writeRight(close)], {
    concurrency: 2,
    discard: true,
  });
});

const forwardSocket = Effect.fn("PreviewLiveGatewayHttp.forwardSocket")(function* (
  source: Socket.Socket,
  destination: Socket.Socket,
) {
  // One extra slot is reserved for the terminal close event. Data admission is
  // governed separately by both frame-count and pending-byte limits.
  const frames = yield* Queue.dropping<BufferedLiveGatewaySocketFrame>(
    LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_FRAMES + 1,
  );
  const overloaded = yield* Deferred.make<void>();
  const write = yield* destination.writer;
  let bufferedBytes = 0;
  let bufferedFrames = 0;
  let didOverload = false;

  const signalOverload = () => {
    if (didOverload) return;
    didOverload = true;
    Deferred.doneUnsafe(overloaded, Effect.void);
  };
  const offerData = (frame: string | Uint8Array) => {
    if (didOverload) return;
    const byteLength = liveGatewaySocketFrameByteLength(frame);
    if (
      byteLength > LIVE_GATEWAY_WEBSOCKET_MAX_FRAME_BYTES ||
      bufferedFrames >= LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_FRAMES ||
      bufferedBytes + byteLength > LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_BYTES
    ) {
      signalOverload();
      return;
    }
    if (!Queue.offerUnsafe(frames, { frame, byteLength })) {
      signalOverload();
      return;
    }
    bufferedFrames += 1;
    bufferedBytes += byteLength;
  };
  const offerClose = (frame: Socket.CloseEvent) => {
    if (didOverload) return;
    if (!Queue.offerUnsafe(frames, { frame, byteLength: 0 })) {
      signalOverload();
    }
  };
  const read = source.runRaw(offerData).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.sync(() => {
          offerClose(forwardedCloseEvent(error));
        }),
      onSuccess: () =>
        Effect.sync(() => {
          offerClose(new Socket.CloseEvent(1_000));
        }),
    }),
  );
  const drain = Effect.gen(function* () {
    while (true) {
      const buffered = yield* Queue.take(frames);
      yield* write(buffered.frame);
      if (Socket.isCloseEvent(buffered.frame)) return;
      bufferedFrames -= 1;
      bufferedBytes -= buffered.byteLength;
    }
  });
  const transfer = Effect.all([read, drain], {
    concurrency: "unbounded",
    discard: true,
  });
  const rejectOverload = Deferred.await(overloaded).pipe(
    Effect.flatMap(() =>
      closeSocketPair(
        source,
        destination,
        new Socket.CloseEvent(1_013, "Live preview websocket buffer exceeded"),
      ),
    ),
  );
  yield* Effect.raceFirst(transfer, rejectOverload);
});

export const bridgeLiveGatewaySockets = Effect.fn("PreviewLiveGatewayHttp.bridgeSockets")(
  function* (left: Socket.Socket, right: Socket.Socket) {
    yield* Effect.raceFirst(forwardSocket(left, right), forwardSocket(right, left));
  },
);

function makeUpstreamWebSocket(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly requestUrl: URL;
  readonly lease: LiveGatewayLease;
  readonly environmentSessionCookieName: string;
}): Effect.Effect<Socket.Socket> {
  const upstreamHttpUrl = liveGatewayUpstreamUrl(input.requestUrl, input.lease);
  const headers = liveGatewayUpstreamHeaders({
    request: input.request,
    requestUrl: input.requestUrl,
    upstreamUrl: upstreamHttpUrl,
    environmentSessionCookieName: input.environmentSessionCookieName,
  });
  const upstreamUrl = new URL(upstreamHttpUrl);
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  const protocols = liveGatewayWebSocketProtocols(input.request.headers["sec-websocket-protocol"]);
  const acquire = Effect.acquireRelease(
    Effect.try({
      try: () =>
        new NodeSocket.NodeWS.WebSocket(upstreamUrl, protocols, {
          followRedirects: false,
          headers: { ...headers },
          maxPayload: LIVE_GATEWAY_WEBSOCKET_MAX_FRAME_BYTES,
        }) as unknown as globalThis.WebSocket,
      catch: (cause) =>
        new Socket.SocketError({
          reason: new Socket.SocketOpenError({
            kind: "Unknown",
            cause,
          }),
        }),
    }),
    (webSocket) =>
      Effect.sync(() => {
        const nodeWebSocket = webSocket as unknown as NodeSocket.NodeWS.WebSocket;
        if (nodeWebSocket.readyState === nodeWebSocket.CONNECTING) {
          nodeWebSocket.terminate();
        } else if (nodeWebSocket.readyState === nodeWebSocket.OPEN) {
          nodeWebSocket.close(1_000);
        }
      }),
  );
  return Socket.fromWebSocket(acquire, {
    closeCodeIsError: () => true,
    openTimeout: UPSTREAM_CONNECT_TIMEOUT,
  });
}

const proxyWebSocketRequest = Effect.fn("PreviewLiveGatewayHttp.proxyWebSocketRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  requestUrl: URL,
  lease: LiveGatewayLease,
  environmentSessionCookieName: string,
) {
  const upstream = yield* makeUpstreamWebSocket({
    request,
    requestUrl,
    lease,
    environmentSessionCookieName,
  });
  const downstream = yield* request.upgrade;
  yield* Effect.raceFirst(
    bridgeLiveGatewaySockets(downstream, upstream),
    lease.invalidated.pipe(
      Effect.flatMap(() =>
        closeSocketPair(
          downstream,
          upstream,
          new Socket.CloseEvent(1_008, "Live preview lease expired or was revoked"),
        ),
      ),
    ),
  );
  return HttpServerResponse.empty();
});

const isEmptyBodyError = (error: HttpClientError.HttpClientError): boolean =>
  error.reason._tag === "EmptyBodyError";

export const interruptLiveGatewayStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  lease: LiveGatewayLease,
): Stream.Stream<A, E, R> => stream.pipe(Stream.interruptWhen(lease.invalidated));

const proxyHttpRequest = Effect.fn("PreviewLiveGatewayHttp.proxyHttpRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  requestUrl: URL,
  lease: LiveGatewayLease,
  environmentSessionCookieName: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const upstreamUrl = liveGatewayUpstreamUrl(requestUrl, lease);
  const upstreamRequest = retargetLiveGatewayRequest(
    HttpServerRequest.toClientRequest(request),
    upstreamUrl,
    liveGatewayUpstreamHeaders({
      request,
      requestUrl,
      upstreamUrl,
      environmentSessionCookieName,
    }),
  );
  const upstream = yield* httpClient
    .execute(upstreamRequest)
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout(UPSTREAM_CONNECT_TIMEOUT),
    );
  const headers = liveGatewayResponseHeaders({
    headers: upstream.headers,
    requestUrl,
    upstreamOrigin: lease.target.origin,
  });
  return HttpServerResponse.stream(
    interruptLiveGatewayStream(
      Stream.catchIf(upstream.stream, isEmptyBodyError, () => Stream.empty),
      lease,
    ),
    {
      status: upstream.status,
      headers,
      cookies: liveGatewayResponseCookies(upstream.cookies, environmentSessionCookieName),
    },
  );
});

function expiredGatewayResponse(): HttpServerResponse.HttpServerResponse {
  const expiredAt = DateTime.toDate(DateTime.makeUnsafe(0));
  const cookies = Cookies.setUnsafe(
    Cookies.setUnsafe(Cookies.empty, LIVE_GATEWAY_COOKIE_NAME, "", {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 0,
      expires: expiredAt,
    }),
    LIVE_GATEWAY_HTTP_COOKIE_NAME,
    "",
    {
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 0,
      expires: expiredAt,
    },
  );
  return HttpServerResponse.text("Live preview session expired.", {
    status: LIVE_GATEWAY_EXPIRED_STATUS,
    headers: bootstrapResponseHeaders,
    cookies,
  });
}

export const liveGatewayBootstrapRouteLayer = HttpRouter.add(
  "GET",
  `${LIVE_GATEWAY_BOOTSTRAP_PREFIX}/*`,
  Effect.gen(function* () {
    const gateway = yield* PreviewLiveGateway;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const token = requestUrl.value.pathname.slice(`${LIVE_GATEWAY_BOOTSTRAP_PREFIX}/`.length);
    if (!BOOTSTRAP_TOKEN_PATTERN.test(token)) {
      return expiredGatewayResponse();
    }
    const consumed = yield* gateway.consumeBootstrap(token);
    if (consumed === null) {
      return expiredGatewayResponse();
    }
    const cookieName = liveGatewayCookieName(requestUrl.value);
    const cookie = yield* Effect.fromResult(
      Cookies.set(Cookies.empty, cookieName, consumed.cookieValue, {
        path: "/",
        secure: cookieName === LIVE_GATEWAY_COOKIE_NAME,
        httpOnly: true,
        sameSite: "strict",
        expires: DateTime.toDate(DateTime.makeUnsafe(consumed.lease.expiresAt)),
      }),
    ).pipe(Effect.orDie);
    return HttpServerResponse.redirect(consumed.lease.target.redirectPath, {
      status: 302,
      headers: bootstrapResponseHeaders,
      cookies: cookie,
    });
  }),
);

export const liveGatewayProxyLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const gateway = yield* PreviewLiveGateway;
      const sessions = yield* SessionStore.SessionStore;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const requestUrl = HttpServerRequest.toURL(request);
      if (
        Option.isNone(requestUrl) ||
        requestUrl.value.pathname.startsWith(`${LIVE_GATEWAY_BOOTSTRAP_PREFIX}/`)
      ) {
        return yield* httpEffect;
      }
      const cookieValue =
        request.cookies[LIVE_GATEWAY_COOKIE_NAME] ?? request.cookies[LIVE_GATEWAY_HTTP_COOKIE_NAME];
      if (!cookieValue) return yield* httpEffect;

      const lease = yield* gateway.resolveLease(cookieValue);
      if (lease === null) return expiredGatewayResponse();

      if (request.headers.upgrade?.toLowerCase() === "websocket") {
        return yield* proxyWebSocketRequest(
          request,
          requestUrl.value,
          lease,
          sessions.cookieName,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Live preview gateway websocket failed", {
              cause,
              threadId: lease.threadId,
              tabId: lease.tabId,
              upstreamOrigin: lease.target.origin,
            }).pipe(Effect.as(HttpServerResponse.empty())),
          ),
        );
      }

      return yield* Effect.raceFirst(
        proxyHttpRequest(request, requestUrl.value, lease, sessions.cookieName),
        lease.invalidated.pipe(Effect.as(expiredGatewayResponse())),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Live preview gateway upstream request failed", {
            cause,
            threadId: lease.threadId,
            tabId: lease.tabId,
            upstreamOrigin: lease.target.origin,
          }).pipe(
            Effect.as(
              HttpServerResponse.text("Live preview upstream is unavailable.", {
                status: 502,
                headers: bootstrapResponseHeaders,
              }),
            ),
          ),
        ),
      );
    }),
  { global: true },
);
