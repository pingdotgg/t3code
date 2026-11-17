// Carries a remote desktop's preview traffic to this machine's loopback ports, one TCP
// connection per WebSocket. Raw bytes, so pages keep their own origin, HMR sockets and TLS.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import type * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { requestUrl } from "../requestUrl.ts";

const PREVIEW_TUNNEL_ROUTE = "/api/preview/tunnel";

const CONNECT_TIMEOUT = "5 seconds";

export class PreviewTunnelPortRefusedError extends Schema.TaggedError<PreviewTunnelPortRefusedError>()(
  "PreviewTunnelPortRefusedError",
  { port: Schema.Number },
) {
  override get message(): string {
    return `Port ${this.port} is this T3 Code server's own port.`;
  }
}

export class PreviewTunnelConnectError extends Schema.TaggedError<PreviewTunnelConnectError>()(
  "PreviewTunnelConnectError",
  { port: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Nothing accepted a connection on loopback port ${this.port}.`;
  }
}

export class PreviewTunnel extends Context.Service<
  PreviewTunnel,
  {
    /** Connects to a loopback port. `servedPort` is the port the request arrived on. */
    readonly connect: (input: {
      readonly port: number;
      readonly servedPort: number | undefined;
    }) => Effect.Effect<
      { readonly reader: Socket.Reader; readonly writer: Socket.Writer },
      PreviewTunnelPortRefusedError | PreviewTunnelConnectError,
      Scope.Scope
    >;
  }
>()("t3/preview/PreviewTunnel") {}

const make = Effect.sync(() => {
  const dial = Effect.fnUntraced(function* (host: string, port: number) {
    const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: CONNECT_TIMEOUT });
    return { reader: yield* socket.reader, writer: yield* socket.writer };
  });

  const connect: PreviewTunnel["Service"]["connect"] = Effect.fn("PreviewTunnel.connect")(
    function* ({ port, servedPort }) {
      yield* Effect.annotateCurrentSpan({ port });
      // Tunnelling to this server would hand the page an unauthenticated loopback client.
      if (port === servedPort) {
        return yield* new PreviewTunnelPortRefusedError({ port });
      }
      return yield* dial("127.0.0.1", port).pipe(
        Effect.catch(() => dial("::1", port)),
        Effect.mapError((cause) => new PreviewTunnelConnectError({ port, cause })),
      );
    },
  );

  return PreviewTunnel.of({ connect });
});

export const layer = Layer.effect(PreviewTunnel, make);

const SEND_HIGH_WATER_BYTES = 1024 * 1024;

// Effect's WebSocket writer never waits for its send buffer, so a slow client would queue a
// whole response in memory. `ws` writes its frames to the upgraded TCP socket; wait on that.
const drained = (connection: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    if (connection.writableLength <= SEND_HIGH_WATER_BYTES || connection.destroyed) {
      return resume(Effect.void);
    }
    const stopWaiting = () => connection.off("drain", done).off("close", done);
    const done = () => {
      stopWaiting();
      resume(Effect.void);
    };
    connection.on("drain", done).on("close", done);
    return Effect.sync(stopWaiting);
  });

const pump =
  /* Runs for the life of the connection; a span per direction adds no diagnostic value. */
  Effect.fnUntraced(function* (
    reader: Socket.Reader,
    writer: Socket.Writer,
    backpressure: Effect.Effect<void> = Effect.void,
  ) {
    while (true) {
      yield* writer.writeAll(yield* reader.pull);
      yield* backpressure;
    }
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  const port = Number(Option.getOrUndefined(url)?.searchParams.get("port") ?? Number.NaN);
  if (
    request.headers.upgrade?.toLowerCase() !== "websocket" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const session = yield* authenticateMediaRequest(AuthTerminalOperateScope);
  const sessions = yield* SessionStore.SessionStore;
  const tunnel = yield* PreviewTunnel;
  const connection = NodeHttpServerRequest.toIncomingMessage(request).socket;
  const servedPort = connection.localPort;
  return yield* Effect.gen(function* () {
    // Dialled before the upgrade so a dead port fails the handshake instead of an open socket.
    const upstream = yield* tunnel.connect({ port, servedPort });
    const client = yield* request.upgrade;
    const clientReader = yield* client.reader;
    const clientWriter = yield* client.writer;
    // A tunnel is raw TCP into the host, so it closes with its session like the RPC socket.
    yield* Effect.raceFirst(
      Effect.raceFirst(
        pump(upstream.reader, clientWriter, drained(connection)),
        pump(clientReader, upstream.writer),
      ),
      sessions.awaitInvalidation(session.sessionId),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      PreviewTunnelPortRefusedError: (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 403 })),
      PreviewTunnelConnectError: (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 502 })),
    }),
  );
});

export const routeLayer = HttpRouter.add("GET", PREVIEW_TUNNEL_ROUTE, handler);
