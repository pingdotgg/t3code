/**
 * The hub binds loopback and is never reachable directly: serve-sim exposes a shell-exec route
 * and serve-emu's action routes are unauthenticated, so the only way to a device stream is
 * through this route, which requires an environment session with read scope (operate scope for
 * input and tuning).
 */
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as DeviceService from "./DeviceService.ts";

const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

const MUTABLE_PATHS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings)$/,
  /^\/vendor\/serve-emu\/api\/fold$/,
];

const ALLOWED_WS_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

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
  // Describes the client's HTTPS hop to T3. The hub builds its own origin from it and then
  // rejects the loopback Origin set below, so every mutation fails over T3 Connect.
  "x-forwarded-proto",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

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
      // Whichever side closes first ends the other via scope teardown: a close
      // fails the pull with a SocketError, which loses the race.
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyHttp = Effect.fn("DeviceHubProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  hubOrigin: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, hubOrigin)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name === "content-encoding" || name === "transfer-encoding" || name === "connection") {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  // Long-lived MJPEG and AVCC responses must not be buffered by compression.
  headers["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const hubPath = url.value.pathname.slice(DeviceService.DEVICE_HUB_ROUTE_PREFIX.length) || "/";
  const upgrade = isWebSocketUpgrade(request);
  const allowed = (upgrade ? ALLOWED_WS_PATHS : ALLOWED_PATHS).some((pattern) =>
    pattern.test(hubPath),
  );
  if (!allowed) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!upgrade && !readOnly && !MUTABLE_PATHS.some((pattern) => pattern.test(hubPath))) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const controlsDevice =
    (upgrade && hubPath !== "/api/devices/ws") ||
    (!readOnly && /\/api\/(stream-(mode|settings)|fold)$/.test(hubPath));
  yield* authenticateMediaRequest(
    controlsDevice ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
  );
  const devices = yield* DeviceService.DeviceService;
  const ready = yield* devices.currentReadiness(url.value.searchParams.get("hostId") ?? undefined);
  if (!ready) {
    return HttpServerResponse.text("Device hub is not running", { status: 503 });
  }
  // The ticket authenticates here and must not travel on to the hub.
  const upstreamSearch = new URLSearchParams(url.value.search);
  upstreamSearch.delete("wsTicket");
  upstreamSearch.delete("hostId");
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

export const layer = HttpRouter.add("*", `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`, handler);
