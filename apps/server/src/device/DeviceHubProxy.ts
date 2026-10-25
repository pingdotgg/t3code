// Loopback-only hubs expose shell execution or unauthenticated actions.
// Proxy with environment read scope for streams and operate scope for input and tuning.
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
import { repeatStillFrame } from "./mjpegStillFrame.ts";

const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

const MUTABLE_PATHS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  // WebRTC signalling: opening and closing a view of the stream, so read scope.
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
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
  // The client's HTTPS hop makes the hub reject our loopback Origin over T3 Connect.
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
  protocols: ReadonlyArray<string> = [],
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    ...(protocols.length > 0 ? { protocols: [...protocols] } : {}),
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
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
  extraHeaders: Readonly<Record<string, string>> = {},
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders({
      ...forwardHeaders(request, new URL(upstreamUrl).origin),
      ...extraHeaders,
    }),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : // A bare stream body is sent as octet-stream; serve-sim refuses WebRTC
        // offers that are not application/json.
        HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    // A cookie from an upstream such as an EAS session's preview host would land on T3's origin.
    if (
      name === "content-encoding" ||
      name === "transfer-encoding" ||
      name === "connection" ||
      name === "set-cookie"
    ) {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  // Long-lived MJPEG and AVCC responses must not be buffered by compression.
  headers["cache-control"] = "no-store, no-transform";
  const body = headers["content-type"]?.startsWith("multipart/x-mixed-replace")
    ? repeatStillFrame(response.stream)
    : response.stream;
  return HttpServerResponse.stream(body, {
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
  // Consume the auth ticket here; never forward it to the hub.
  const upstreamSearch = new URLSearchParams(url.value.search);
  upstreamSearch.delete("wsTicket");
  upstreamSearch.delete("hostId");
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  // Hosts with several upstreams (one per cloud session) route and authenticate requests themselves.
  const routed = ready.upstream ? yield* ready.upstream(hubPath, upstreamSearch) : undefined;
  if (routed === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const upstreamUrl = routed?.url ?? `${ready.hub.origin}${hubPath}${search}`;
  if (upgrade) {
    return yield* proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), routed?.protocols);
  }
  return yield* proxyHttp(request, upstreamUrl, routed?.headers);
});

export const layer = HttpRouter.add("*", `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`, handler);
