// Carries a remote desktop's preview traffic to this machine's loopback ports, one TCP
// connection per WebSocket. Raw bytes, so pages keep their own origin, HMR sockets and TLS.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { allowsPreviewTunnel, AuthTerminalOperateScope } from "@t3tools/contracts";
import type * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { requestUrl } from "../requestUrl.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const PREVIEW_TUNNEL_ROUTE = "/api/preview/tunnel";
/**
 * Marks a refusal about the port itself, so a client can tell "nothing listens there" from a proxy
 * in front of the environment answering 502 because the environment is down.
 */
export const PREVIEW_TUNNEL_PORT_REFUSED_HEADER = "x-t3-tunnel-port-refused";
/** Marks a refusal because the tunnel is switched off here, by the setting or by policy. */
export const PREVIEW_TUNNEL_DISABLED_HEADER = "x-t3-tunnel-disabled";

const CONNECT_TIMEOUT = "5 seconds";

export class PreviewTunnelPortRefusedError extends Schema.TaggedError<PreviewTunnelPortRefusedError>()(
  "PreviewTunnelPortRefusedError",
  { port: Schema.Number },
) {
  override get message(): string {
    return `Port ${this.port} is this T3 Code server's own port.`;
  }
}

export class PreviewTunnelDisabledError extends Schema.TaggedError<PreviewTunnelDisabledError>()(
  "PreviewTunnelDisabledError",
  {},
) {
  override get message(): string {
    return "The preview tunnel is turned off on this T3 Code server.";
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

class PreviewTunnel extends Context.Service<
  PreviewTunnel,
  {
    /** Connects to a loopback port. `servedPort` is the port the request arrived on. */
    readonly connect: (input: {
      readonly port: number;
      readonly servedPort: number | undefined;
    }) => Effect.Effect<
      { readonly reader: Socket.Reader; readonly writer: Socket.Writer },
      PreviewTunnelDisabledError | PreviewTunnelPortRefusedError | PreviewTunnelConnectError,
      Scope.Scope
    >;
    /**
     * Subscribes now, before `connect` reads the setting, so a switch-off during dialling isn't
     * missed. The returned effect completes once the tunnel is switched off.
     */
    readonly watchTurnedOff: Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
  }
>()("t3/preview/PreviewTunnel") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const managedPolicy = serverSettings.managedPolicy;
  const allowedBy = (settings: { readonly enablePreviewTunnel: boolean }) =>
    allowsPreviewTunnel({ settings, managedPolicy });
  // Unreadable settings fail closed: the tunnel is raw TCP into the host.
  const enabled = serverSettings.getSettings.pipe(
    Effect.map(allowedBy),
    Effect.orElseSucceed(() => false),
  );
  const watchTurnedOff = serverSettings.subscribeChanges.pipe(
    Effect.map((changes) =>
      changes.pipe(
        Stream.filter((settings) => !allowedBy(settings)),
        Stream.runHead,
        // A change stream that ends without switching the tunnel off never does.
        Effect.flatMap((change) => (Option.isSome(change) ? Effect.void : Effect.never)),
      ),
    ),
  );

  const dial = Effect.fnUntraced(function* (host: string, port: number) {
    const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: CONNECT_TIMEOUT });
    return { reader: yield* socket.reader, writer: yield* socket.writer };
  });

  const connect: PreviewTunnel["Service"]["connect"] = Effect.fn("PreviewTunnel.connect")(
    function* ({ port, servedPort }) {
      yield* Effect.annotateCurrentSpan({ port });
      if (!(yield* enabled)) return yield* new PreviewTunnelDisabledError();
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

  return PreviewTunnel.of({ connect, watchTurnedOff });
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
    const turnedOff = yield* tunnel.watchTurnedOff;
    // Dialled before the upgrade so a dead port fails the handshake instead of an open socket.
    const upstream = yield* tunnel.connect({ port, servedPort });
    const client = yield* request.upgrade;
    const clientReader = yield* client.reader;
    const clientWriter = yield* client.writer;
    // A tunnel is raw TCP into the host, so it closes with its session like the RPC socket.
    // So does switching the tunnel off.
    yield* Effect.raceFirst(
      Effect.raceFirst(
        pump(upstream.reader, clientWriter, drained(connection)),
        pump(clientReader, upstream.writer),
      ),
      Effect.raceFirst(
        sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint),
        turnedOff,
      ),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      PreviewTunnelDisabledError: (error) =>
        Effect.succeed(
          HttpServerResponse.text(error.message, { status: 403, headers: DISABLED_HEADERS }),
        ),
      PreviewTunnelPortRefusedError: (error) =>
        Effect.succeed(
          HttpServerResponse.text(error.message, { status: 403, headers: PORT_REFUSED_HEADERS }),
        ),
      // Not 502: Cloudflare, in front of T3 Connect, swaps an origin 502 for its own page.
      PreviewTunnelConnectError: (error) =>
        Effect.succeed(
          HttpServerResponse.text(error.message, { status: 403, headers: PORT_REFUSED_HEADERS }),
        ),
    }),
  );
});

const PORT_REFUSED_HEADERS = { [PREVIEW_TUNNEL_PORT_REFUSED_HEADER]: "1" };
const DISABLED_HEADERS = { [PREVIEW_TUNNEL_DISABLED_HEADER]: "1" };

export const routeLayer = HttpRouter.add("GET", PREVIEW_TUNNEL_ROUTE, handler);
