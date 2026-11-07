import { requestUrl } from "../requestUrl.ts";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  LAN_GATEWAY_ROUTE_PREFIX,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as LanGateway from "./LanGateway.ts";

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "accept-encoding",
  "x-forwarded-proto",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  // Node fetch may decompress while leaving the compressed length; never forward that.
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const connectionListedHeaders = (connection: string | undefined): ReadonlySet<string> => {
  if (connection === undefined || connection.length === 0) return new Set();
  return new Set(
    connection
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
};

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const hop = connectionListedHeaders(request.headers.connection);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || hop.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
};

const upstreamWebSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

const proxyWebSocket = Effect.fn("LanGatewayProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    headers: forwardHeaders(request),
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
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

const pumpFrames = Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
  const { pull } = yield* source.reader;
  while (true) {
    yield* sink.writeAll(yield* pull);
  }
});

const proxyHttp = Effect.fn("LanGatewayProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  // Peers must not redirect the gateway onto a public or other host.
  const httpClient = HttpClient.withScope(
    HttpClient.transform(yield* HttpClient.HttpClient, (response) =>
      Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  // Node's fetch otherwise asks for gzip and decompresses while keeping the compressed
  // content-length; Effect then aborts the client write as a length mismatch.
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request)),
    HttpClientRequest.setHeader("accept-encoding", "identity"),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const hop = connectionListedHeaders(response.headers.connection);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || hop.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const parseGatewayPath = (pathname: string) => {
  if (!pathname.startsWith(`${LAN_GATEWAY_ROUTE_PREFIX}/`)) return Option.none();
  const remainder = pathname.slice(LAN_GATEWAY_ROUTE_PREFIX.length + 1);
  if (remainder.length === 0) return Option.none();
  const slash = remainder.indexOf("/");
  const environmentId = slash === -1 ? remainder : remainder.slice(0, slash);
  if (environmentId.length === 0) return Option.none();
  const upstreamPath = slash === -1 ? "/" : remainder.slice(slash);
  return Option.some({ environmentId, upstreamPath });
};

/**
 * A `wsTicket` belongs to the peer and would fail here, so the gateway hop authenticates with
 * `gatewayTicket`, or with its session cookie when there is none.
 */
const withGatewayHopTicket = (request: HttpServerRequest.HttpServerRequest) => {
  const url = requestUrl(request);
  if (Option.isNone(url)) return request;
  const rewritten = new URL(url.value.toString());
  const gatewayTicket = rewritten.searchParams.get("gatewayTicket");
  if (gatewayTicket === null || gatewayTicket.length === 0) {
    rewritten.searchParams.delete("wsTicket");
  } else {
    rewritten.searchParams.set("wsTicket", gatewayTicket);
  }
  rewritten.searchParams.delete("gatewayTicket");
  return request.modify({ url: `${rewritten.pathname}${rewritten.search}` });
};

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const parsed = parseGatewayPath(url.value.pathname);
  if (Option.isNone(parsed)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  yield* authenticateMediaRequest(AuthOrchestrationReadScope).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, withGatewayHopTicket(request)),
  );
  const gateway = yield* LanGateway.LanGateway;
  const upstreamBase = yield* gateway.resolveUpstream(
    EnvironmentId.make(parsed.value.environmentId),
  );
  if (Option.isNone(upstreamBase)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const upstreamSearch = new URLSearchParams(url.value.search);
  upstreamSearch.delete("gatewayTicket");
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  const upstreamUrl = `${upstreamBase.value}${parsed.value.upstreamPath}${search}`;
  if (isWebSocketUpgrade(request)) {
    return yield* proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"));
  }
  return yield* proxyHttp(request, upstreamUrl);
});

export const layer = HttpRouter.add("*", `${LAN_GATEWAY_ROUTE_PREFIX}/*`, handler);

/** Exported for unit tests that assert path rewriting without a live upstream. */
export const rewriteUpstreamUrl = (
  pathname: string,
  search: string,
  upstreamBase: string,
): Option.Option<string> => {
  const parsed = parseGatewayPath(pathname);
  if (Option.isNone(parsed)) return Option.none();
  const upstreamSearch = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  upstreamSearch.delete("gatewayTicket");
  const query = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  return Option.some(`${upstreamBase}${parsed.value.upstreamPath}${query}`);
};
