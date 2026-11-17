// Renders another environment's localhost pages in a local webview: the partition's loopback
// traffic goes to a SOCKS5 listener here, and each connection rides one WebSocket to the
// environment's /api/preview/tunnel. The page keeps its localhost origin.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import type { DesktopPreviewTunnelAccessRequest } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { PREVIEW_TUNNEL_ACCESS_REQUEST_CHANNEL } from "../ipc/channels.ts";

const ACCESS_TIMEOUT = "15 seconds";
const CONNECT_TIMEOUT = "10 seconds";

const REPLY_SUCCEEDED = 0;
const REPLY_FAILURE = 1;
const REPLY_NOT_ALLOWED = 2;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_NOT_SUPPORTED = 8;

const socksReply = (code: number) => Uint8Array.of(5, code, 0, 1, 0, 0, 0, 0, 0, 0);

// Chromium names the host as typed, so IP literals also arrive as domain names, and a fully
// qualified `localhost.` keeps its trailing dot.
const isLoopbackName = (typed: string) => {
  const name = typed.replace(/\.$/, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    Result.match(NetAddress.ipFromString(name), {
      onSuccess: NetAddress.isLoopback,
      onFailure: () => false,
    })
  );
};

// `*://` matches only http and https, so WebSocket schemes are listed separately.
const UNSPECIFIED_ADDRESS_URLS = ["http", "https", "ws", "wss"].flatMap((scheme) => [
  `${scheme}://0.0.0.0/*`,
  `${scheme}://[::]/*`,
]);

const sendUnspecifiedToLocalhost = (
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void,
) => {
  const url = new URL(details.url);
  // A WebSocket handshake can't be redirected.
  if (url.protocol === "ws:" || url.protocol === "wss:") return callback({ cancel: true });
  url.hostname = "localhost";
  callback({ redirectURL: url.toString() });
};

type SocksRequest = { readonly port: number } | { readonly refusal: number };

/** Undefined until the whole request has arrived. */
const parseConnect = (data: Buffer): SocksRequest | undefined => {
  if (data.length < 5) return undefined;
  const addressType = data[3];
  const hostLength =
    addressType === 1 ? 4 : addressType === 4 ? 16 : addressType === 3 ? 1 + data[4]! : -1;
  if (hostLength < 0) return { refusal: REPLY_ADDRESS_NOT_SUPPORTED };
  if (data.length < 4 + hostLength + 2) return undefined;
  if (data[0] !== 5 || data[1] !== 1) return { refusal: REPLY_COMMAND_NOT_SUPPORTED };
  const host = data.subarray(4, 4 + hostLength);
  const loopback =
    addressType === 1
      ? NetAddress.isLoopback(NetAddress.ipv4FromBytesUnsafe(host))
      : addressType === 4
        ? NetAddress.isLoopback(NetAddress.ipv6FromBytesUnsafe(host))
        : isLoopbackName(host.subarray(1).toString("latin1").toLowerCase());
  return loopback ? { port: data.readUInt16BE(4 + hostLength) } : { refusal: REPLY_NOT_ALLOWED };
};

/** Answers the greeting and reads the CONNECT; undefined when the client offers no usable auth. */
const readSocksRequest = Effect.fn("LoopbackTunnel.readSocksRequest")(function* (
  pull: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>,
  writer: Socket.Writer,
) {
  let received = Buffer.alloc(0);
  let greeted = false;
  while (true) {
    received = Buffer.concat([received, ...(yield* pull)]);
    if (!greeted) {
      const methods = received[1];
      if (methods === undefined || received.length < 2 + methods) continue;
      if (received[0] !== 5 || !received.subarray(2, 2 + methods).includes(0)) {
        yield* writer.write(Uint8Array.of(5, 0xff));
        return undefined;
      }
      yield* writer.write(Uint8Array.of(5, 0));
      received = received.subarray(2 + methods);
      greeted = true;
    }
    const request = parseConnect(received);
    if (request !== undefined) return request;
  }
});

// Over an SSH forward the environment's own origin is a loopback port here, and signed asset
// URLs point at it. That port is the environment, not one of its loopback servers.
const tunnelEndpoint = (tunnelUrl: string) => {
  const url = new URL(tunnelUrl);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
  };
};

const isTunnelEndpoint = (tunnelUrl: string, port: number) => {
  const endpoint = tunnelEndpoint(tunnelUrl);
  return isLoopbackName(endpoint.host) && endpoint.port === port;
};

/** Opens a connection to the destination; `ws` pauses its socket, so a slow page slows the tunnel. */
const dialDestination = Effect.fn("LoopbackTunnel.dialDestination")(function* (
  tunnelUrl: string,
  port: number,
) {
  if (isTunnelEndpoint(tunnelUrl, port)) {
    const endpoint = yield* NodeSocket.makeNet({
      ...tunnelEndpoint(tunnelUrl),
      openTimeout: CONNECT_TIMEOUT,
    });
    return { pull: yield* Socket.readerBytes(endpoint), writer: yield* endpoint.writer };
  }
  const url = new URL(tunnelUrl);
  url.searchParams.set("port", String(port));
  const tunnel = yield* Effect.acquireRelease(
    Effect.sync(() =>
      // Closing before the handshake finishes emits an error after Socket's listeners are gone.
      new NodeWS.WebSocket(url).on("error", () => undefined),
    ),
    (tunnel) => Effect.sync(() => tunnel.close()),
  );
  const socket = yield* Socket.fromWebSocket(Effect.succeed(tunnel), {
    openTimeout: CONNECT_TIMEOUT,
  });
  // Effect's WebSocket writer never waits for the send buffer; `ws` calls back once it is written.
  const sendAll = (chunks: NonEmptyReadonlyArray<Uint8Array>) =>
    Effect.callback<void>((resume) => {
      const last = chunks.length - 1;
      chunks.forEach((chunk, index) =>
        tunnel.send(chunk, index === last ? () => resume(Effect.void) : undefined),
      );
    });
  return {
    pull: yield* Socket.readerBytes(socket),
    writer: { write: (chunk: Uint8Array) => sendAll([chunk]), writeAll: sendAll },
  };
});

const TCP_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

// Rows read `sl local_address rem_address st queues timer retransmits uid ...`, with addresses
// as HEXIP:HEXPORT and IPv4 bytes in little-endian order; tcp6 holds IPv4 as ::ffff:a.b.c.d.
const procAddresses = (ip: string, port: number) => {
  const octets = ip
    .replace(/^::ffff:/i, "")
    .split(".")
    .map(Number);
  const v4 = octets
    .reverse()
    .map((octet) => octet.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const hexPort = port.toString(16).padStart(4, "0").toUpperCase();
  return [`${v4}:${hexPort}`, `0000000000000000FFFF0000${v4}:${hexPort}`];
};

/** The owner of the row whose local end is the client and remote end is the listener. */
const connectionOwner = (
  tables: ReadonlyArray<string>,
  client: { readonly address: string; readonly port: number },
  listener: { readonly address: string; readonly port: number },
) => {
  const clientEnds = procAddresses(client.address, client.port);
  const listenerEnds = procAddresses(listener.address, listener.port);
  for (const line of tables.flatMap((table) => table.split("\n").slice(1))) {
    const [, local, remote, , , , , uid] = line.trim().split(/\s+/);
    if (
      local !== undefined &&
      remote !== undefined &&
      clientEnds.includes(local.toUpperCase()) &&
      listenerEnds.includes(remote.toUpperCase())
    ) {
      return Number(uid);
    }
  }
  return undefined;
};

const pump =
  /* Runs for the life of the connection; a span per direction adds no diagnostic value. */
  Effect.fnUntraced(function* (
    pull: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>,
    writeAll: (
      chunks: NonEmptyReadonlyArray<Uint8Array>,
    ) => Effect.Effect<void, Socket.SocketError>,
  ) {
    while (true) yield* writeAll(yield* pull);
  });

export class LoopbackTunnelRouteError extends Schema.TaggedError<LoopbackTunnelRouteError>()(
  "LoopbackTunnelRouteError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to route preview traffic for environment "${this.environmentId}".`;
  }
}

export class LoopbackTunnel extends Context.Service<
  LoopbackTunnel,
  {
    /** Sends a preview session's loopback traffic to its environment, or back to this machine. */
    readonly route: (input: {
      readonly environmentId: string;
      readonly session: Electron.Session;
      readonly tunnelled: boolean;
    }) => Effect.Effect<void, LoopbackTunnelRouteError>;
    readonly resolveAccess: (input: {
      readonly requestId: string;
      readonly url: string | null;
    }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/preview/LoopbackTunnel") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const listenerScope = yield* Effect.scope;
  const routing = yield* Semaphore.make(1);
  const pending = new Map<string, Deferred.Deferred<string | null>>();
  const listenerPorts = new Map<string, number>();
  const routed = new WeakSet<Electron.Session>();
  let requestCount = 0;

  // The renderer owns environment credentials and the selected route, so it is asked per
  // connection; it decides how long a ticket is reused.
  const requestAccess = Effect.fn("LoopbackTunnel.requestAccess")(function* (
    environmentId: string,
  ) {
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.isDestroyed()) return null;
    const requestId = `preview-tunnel-${requestCount++}`;
    const answer = yield* Deferred.make<string | null>();
    pending.set(requestId, answer);
    window.value.webContents.send(PREVIEW_TUNNEL_ACCESS_REQUEST_CHANNEL, {
      requestId,
      environmentId,
    } as DesktopPreviewTunnelAccessRequest);
    return yield* Deferred.await(answer).pipe(
      Effect.timeoutOption(ACCESS_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
    );
  });

  // Chromium can't authenticate to a SOCKS proxy, so on Linux the listener checks that the
  // client belongs to this OS user. Other users could otherwise ride this user's tunnel.
  const isOwnConnection = Effect.fn("LoopbackTunnel.isOwnConnection")(function* () {
    if (platform !== "linux") return true;
    const connection = yield* Effect.serviceOption(NodeSocket.NetSocket);
    if (Option.isNone(connection)) return false;
    const { remoteAddress, remotePort, localAddress, localPort } = connection.value;
    if (!remoteAddress || !remotePort || !localAddress || !localPort) return false;
    const tables = yield* Effect.forEach(TCP_TABLES, (path) =>
      fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => "")),
    );
    return (
      connectionOwner(
        tables,
        { address: remoteAddress, port: remotePort },
        { address: localAddress, port: localPort },
      ) === userId
    );
  });

  /** Serves one SOCKS connection; never falls back to a direct local connection. */
  const serve = (environmentId: string) =>
    Effect.fn("LoopbackTunnel.serve")(
      function* (socket: Socket.Socket) {
        const pull = yield* Socket.readerBytes(socket);
        const writer = yield* socket.writer;
        // "No acceptable methods": the only refusal a client gets before its request.
        if (!(yield* isOwnConnection())) return yield* writer.write(Uint8Array.of(5, 0xff));
        const request = yield* readSocksRequest(pull, writer);
        if (request === undefined) return;
        if ("refusal" in request) return yield* writer.write(socksReply(request.refusal));
        const tunnelUrl = yield* requestAccess(environmentId);
        if (tunnelUrl === null) return yield* writer.write(socksReply(REPLY_FAILURE));
        const destination = yield* dialDestination(tunnelUrl, request.port).pipe(Effect.option);
        if (Option.isNone(destination)) return yield* writer.write(socksReply(REPLY_FAILURE));
        yield* writer.write(socksReply(REPLY_SUCCEEDED));
        return yield* Effect.raceFirst(
          pump(pull, destination.value.writer.writeAll),
          pump(destination.value.pull, writer.writeAll),
        );
      },
      Effect.scoped,
      (effect) => Effect.ignoreCause(effect),
    );

  const listen = Effect.fn("LoopbackTunnel.listen")(function* (environmentId: string) {
    const existing = listenerPorts.get(environmentId);
    if (existing !== undefined) return existing;
    // Listeners live as long as the app: a session can be routed back through at any time.
    const server = yield* NodeSocketServer.make({ port: 0, host: "127.0.0.1" }).pipe(
      Scope.provide(listenerScope),
      Effect.mapError((cause) => new LoopbackTunnelRouteError({ environmentId, cause })),
    );
    yield* server.run(serve(environmentId)).pipe(Effect.forkIn(listenerScope));
    const port = (server.address as NetAddress.InetAddress).port;
    listenerPorts.set(environmentId, port);
    return port;
  });

  const route: LoopbackTunnel["Service"]["route"] = Effect.fn("LoopbackTunnel.route")(function* ({
    environmentId,
    session,
    tunnelled,
  }) {
    if (routed.has(session) === tunnelled) return;
    const port = tunnelled ? yield* listen(environmentId) : null;
    yield* Effect.tryPromise({
      try: async () => {
        await session.setProxy(
          port === null
            ? { mode: "system" }
            : {
                mode: "fixed_servers",
                proxyRules: `socks5://127.0.0.1:${port}`,
                // Chromium never asks a PAC script about loopback hosts, so the split is done
                // here: `*` sends everything direct, and the later `<-loopback>` takes loopback
                // back out of that bypass, along with link-local, which the CIDRs return. The
                // last matching rule wins. A fixed proxy has no direct retry.
                proxyBypassRules: "*,<-loopback>,169.254.0.0/16,fe80::/10",
              },
        );
        // The bypass rules don't cover the unspecified address, so it would reach this machine.
        if (port === null) session.webRequest.onBeforeRequest(null);
        else {
          session.webRequest.onBeforeRequest(
            { urls: UNSPECIFIED_ADDRESS_URLS },
            sendUnspecifiedToLocalhost,
          );
        }
        await session.closeAllConnections();
      },
      catch: (cause) => new LoopbackTunnelRouteError({ environmentId, cause }),
    });
    if (tunnelled) routed.add(session);
    else routed.delete(session);
  }, routing.withPermits(1));

  const resolveAccess: LoopbackTunnel["Service"]["resolveAccess"] = ({ requestId, url }) => {
    const answer = pending.get(requestId);
    return answer ? Deferred.succeed(answer, url).pipe(Effect.asVoid) : Effect.void;
  };

  return LoopbackTunnel.of({ route, resolveAccess });
});

export const layer = Layer.effect(LoopbackTunnel, make);
