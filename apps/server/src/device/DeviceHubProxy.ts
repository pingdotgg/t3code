/**
 * Same-origin proxy in front of expo-device-hub.
 *
 * The hub binds loopback and is never reachable directly: serve-sim exposes a
 * shell-exec route and serve-emu's action routes are unauthenticated, so the
 * only way to a device stream is through this route, which requires an
 * environment session with the orchestration read scope. Reusing the T3
 * origin is also what makes remote connections work unchanged — Tailscale and
 * T3 Connect already carry `/api/*` and WebSocket upgrades for the app itself.
 *
 * Only the routes the Device panel needs are forwarded. Anything under the
 * hub's dashboard, exec, or WebRTC surface is rejected here.
 */
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { DEVICE_HUB_ROUTE_PREFIX, DeviceService } from "./DeviceService.ts";

const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings)$/,
  /^\/vendor\/serve-emu\/health$/,
];

const ALLOWED_WS_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

/** Hop-by-hop and origin headers that must not cross the proxy. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/**
 * `<img>` and WebSocket cannot set headers, so every proxied request
 * authenticates the way the `/ws` upgrade does: a cookie for browser
 * sessions, or a short-lived `wsTicket` minted over authenticated HTTP for
 * bearer and DPoP clients. The upgrade authenticator already implements that
 * fallback order, so it is used for plain requests as well.
 */
const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // serve-emu refuses mutations whose Origin differs from the request origin.
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
};

/**
 * Pipe a client WebSocket to the hub's with no framing changes. Frames are
 * opaque: H.264 access units one way, input packets the other.
 */
const proxyWebSocket = Effect.fn("DeviceHubProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      const downstream = upstream.runRaw((data) => writeToClient(data));
      const upstreamPump = client.runRaw((data) => writeToUpstream(data));
      // Whichever side closes first ends the other via scope teardown.
      yield* Effect.raceFirst(downstream, upstreamPump);
    }),
  ).pipe(Effect.catchCause(() => Effect.void));
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("DeviceHubProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  hubOrigin: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Scope.make();
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, hubOrigin)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream),
  );
  const response = yield* httpClient.execute(upstreamRequest).pipe(Scope.provide(scope));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name === "content-encoding" || name === "transfer-encoding" || name === "connection") {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  // Long-lived MJPEG and AVCC responses must not be buffered by compression.
  headers["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(
    response.stream.pipe(Stream.ensuring(Scope.close(scope, undefined as never))),
    {
      status: response.status,
      headers,
      ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
    },
  );
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const hubPath = url.value.pathname.slice(DEVICE_HUB_ROUTE_PREFIX.length) || "/";
  const upgrade = isWebSocketUpgrade(request);
  const allowed = (upgrade ? ALLOWED_WS_PATHS : ALLOWED_PATHS).some((pattern) =>
    pattern.test(hubPath),
  );
  if (!allowed) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  yield* authenticate;
  const devices = yield* DeviceService;
  const ready = yield* devices.currentReadiness();
  if (!ready) {
    return HttpServerResponse.text("Device hub is not running", { status: 503 });
  }
  // The hub runs in standalone mode at its origin root; the panel builds every
  // stream and socket URL itself, so nothing depends on the hub knowing the
  // T3 prefix.
  // The ticket authenticates here and must not travel on to the hub.
  const upstreamSearch = new URLSearchParams(url.value.search);
  upstreamSearch.delete("wsTicket");
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  const upstreamPath = `${hubPath}${search}`;
  if (upgrade) {
    return yield* proxyWebSocket(
      request,
      `${ready.hub.origin.replace(/^http/, "ws")}${upstreamPath}`,
    );
  }
  return yield* proxyHttp(request, `${ready.hub.origin}${upstreamPath}`, ready.hub.origin);
});

export const deviceHubProxyRouteLayer = HttpRouter.add(
  "*",
  `${DEVICE_HUB_ROUTE_PREFIX}/*`,
  handler,
);
