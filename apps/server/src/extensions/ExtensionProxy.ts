import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import { assetResponseHeaders } from "../http.ts";
import { ExtensionHost } from "./ExtensionHost.ts";

const authenticate = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(cause)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(cause),
              EnvironmentAuth.serverAuthDpopFailureReason(cause),
            );
          }
          return yield* failEnvironmentInternal("internal_error", cause);
        }),
      ),
    );
    if (!session.scopes.includes(scope)) return yield* failEnvironmentScopeRequired(scope);
  });

const pump = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) yield* sink.writeAll(yield* pull);
  });

const proxyHandler = Effect.gen(function* () {
  yield* authenticate(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const host = yield* ExtensionHost;
  const port = yield* host.port;
  const upstream = `http://127.0.0.1:${port}${url.value.pathname}${url.value.search}`;
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    const client = yield* request.upgrade;
    const server = yield* Socket.makeWebSocket(upstream.replace(/^http/, "ws"), {
      openTimeout: "10 seconds",
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const toClient = yield* client.writer;
        const toServer = yield* server.writer;
        return yield* Effect.raceFirst(pump(server, toClient), pump(client, toServer));
      }),
    ).pipe(Effect.catchCause(() => Effect.void));
    return HttpServerResponse.empty();
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      [
        "host",
        "connection",
        "upgrade",
        "cookie",
        "authorization",
        "dpop",
        "content-length",
        "accept-encoding",
      ].includes(name) ||
      value === undefined
    )
      continue;
    headers[name] = value;
  }
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const outbound = HttpClientRequest.make(request.method)(upstream).pipe(
    HttpClientRequest.setHeaders(headers),
    request.method === "GET" || request.method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream),
  );
  const response = yield* client.execute(outbound);
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      ["connection", "transfer-encoding", "content-encoding", "set-cookie"].includes(name) ||
      value === undefined
    )
      continue;
    responseHeaders[name] = value;
  }
  responseHeaders["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
  });
});

const iconHandler = Effect.gen(function* () {
  yield* authenticate(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const parts = url.value.pathname.slice("/api/vscode-icons/".length).split("/", 2);
  const id = yield* Effect.try({
    try: () => decodeURIComponent(parts[0] ?? ""),
    catch: () => new ExtensionError({ operation: "list", detail: "Invalid icon path." }),
  });
  const relative = parts[1]
    ? yield* Effect.try({
        try: () => decodeURIComponent(parts[1]!),
        catch: () => new ExtensionError({ operation: "list", detail: "Invalid icon path." }),
      })
    : undefined;
  const host = yield* ExtensionHost;
  const path = yield* host.iconPath(id, relative);
  return path
    ? yield* HttpServerResponse.file(path, { headers: assetResponseHeaders(path) })
    : HttpServerResponse.text("Not Found", { status: 404 });
});

export const vscodeProxyRouteLayer = HttpRouter.add("*", "/api/vscode/*", proxyHandler);
export const vscodeIconRouteLayer = HttpRouter.add("GET", "/api/vscode-icons/*", iconHandler);
