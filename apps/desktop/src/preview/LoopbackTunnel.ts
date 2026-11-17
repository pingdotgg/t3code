// Renders another environment's localhost pages in a local webview: the partition's loopback
// traffic goes to a SOCKS5 listener here, and each connection rides one WebSocket to the
// environment's /api/preview/tunnel. The page keeps its localhost origin.
import * as NodeNet from "node:net";

import type { DesktopPreviewTunnelAccessRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { PREVIEW_TUNNEL_ACCESS_REQUEST_CHANNEL } from "../ipc/channels.ts";

const ACCESS_TIMEOUT = "15 seconds";
const SEND_HIGH_WATER_BYTES = 1024 * 1024;
const RECEIVE_LIMIT_BYTES = 64 * 1024 * 1024;
const DRAIN_POLL = "20 millis";

const REPLY_SUCCEEDED = 0;
const REPLY_FAILURE = 1;
const REPLY_NOT_ALLOWED = 2;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_NOT_SUPPORTED = 8;
const IPV6_LOOPBACK = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

const socksReply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// Chromium names the host as typed, so IP literals also arrive as domain names.
const isLoopbackName = (name: string) =>
  name === "localhost" ||
  name.endsWith(".localhost") ||
  name === "::1" ||
  (NodeNet.isIPv4(name) && name.startsWith("127."));

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

/** Undefined until the whole request has arrived. */
const parseConnect = (
  data: Buffer,
): { readonly port: number } | { readonly refusal: number } | undefined => {
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
      ? host[0] === 127
      : addressType === 4
        ? host.equals(IPV6_LOOPBACK)
        : isLoopbackName(host.subarray(1).toString("latin1").toLowerCase());
  return loopback ? { port: data.readUInt16BE(4 + hostLength) } : { refusal: REPLY_NOT_ALLOWED };
};

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

const pipeToEndpoint = (socket: NodeNet.Socket, tunnelUrl: string) => {
  const endpoint = NodeNet.connect(tunnelEndpoint(tunnelUrl));
  endpoint.once("connect", () => {
    socket.write(socksReply(REPLY_SUCCEEDED));
    socket.pipe(endpoint);
    endpoint.pipe(socket);
    socket.resume();
  });
  endpoint.once("error", () => {
    if (endpoint.connecting) socket.end(socksReply(REPLY_FAILURE));
    else socket.destroy();
  });
  socket.once("close", () => endpoint.destroy());
};

/** Pipes an accepted SOCKS connection through the tunnel WebSocket; never falls back to direct. */
const pipeThroughTunnel = (
  socket: NodeNet.Socket,
  tunnelUrl: string,
  port: number,
  whenDrained: (tunnel: WebSocket, resume: () => void) => void,
) => {
  const url = new URL(tunnelUrl);
  url.searchParams.set("port", String(port));
  const tunnel = new WebSocket(url);
  tunnel.binaryType = "arraybuffer";
  let opened = false;
  let draining = false;
  tunnel.addEventListener("open", () => {
    opened = true;
    socket.write(socksReply(REPLY_SUCCEEDED));
    socket.resume();
  });
  tunnel.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    socket.write(new Uint8Array(event.data));
    // WebSocket has no way to pause its sender, so a page that stops reading loses the connection.
    if (socket.writableLength > RECEIVE_LIMIT_BYTES) socket.destroy();
  });
  tunnel.addEventListener("close", () => {
    // end() flushes what the page has not read yet; destroy() would truncate the response.
    if (opened) socket.end();
    else socket.end(socksReply(REPLY_FAILURE));
  });
  socket.on("data", (chunk) => {
    tunnel.send(chunk);
    if (draining || tunnel.bufferedAmount < SEND_HIGH_WATER_BYTES) return;
    draining = true;
    socket.pause();
    whenDrained(tunnel, () => {
      draining = false;
      socket.resume();
    });
  });
  socket.on("close", () => tunnel.close());
};

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
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const routing = yield* Semaphore.make(1);
  const pending = new Map<string, Deferred.Deferred<string | null>>();
  const listeners = new Map<string, NodeNet.Server>();
  const sockets = new Set<NodeNet.Socket>();
  const routed = new WeakSet<Electron.Session>();
  let requestCount = 0;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const server of listeners.values()) server.close();
      for (const socket of sockets) socket.destroy();
    }),
  );

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

  // WebSocket reports no drain event, so its send buffer is polled while a socket is paused.
  const whenDrained = (tunnel: WebSocket, resume: () => void) => {
    runFork(
      Effect.sleep(DRAIN_POLL).pipe(
        Effect.repeat({
          until: () =>
            tunnel.readyState !== WebSocket.OPEN || tunnel.bufferedAmount < SEND_HIGH_WATER_BYTES,
        }),
        Effect.map(resume),
      ),
    );
  };

  const accept = (environmentId: string) => (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let received = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (!greeted) {
        const methods = received[1];
        if (methods === undefined || received.length < 2 + methods) return;
        if (received[0] !== 5 || !received.subarray(2, 2 + methods).includes(0)) {
          socket.end(Buffer.from([5, 0xff]));
          return;
        }
        socket.write(Buffer.from([5, 0]));
        received = received.subarray(2 + methods);
        greeted = true;
      }
      const request = parseConnect(received);
      if (request === undefined) return;
      socket.off("data", onData);
      socket.pause();
      if ("refusal" in request) {
        socket.end(socksReply(request.refusal));
        return;
      }
      runFork(
        requestAccess(environmentId).pipe(
          Effect.map((url) => {
            if (socket.destroyed) return;
            if (url === null) socket.end(socksReply(REPLY_FAILURE));
            else if (isTunnelEndpoint(url, request.port)) pipeToEndpoint(socket, url);
            else pipeThroughTunnel(socket, url, request.port, whenDrained);
          }),
        ),
      );
    };
    socket.on("data", onData);
  };

  const listen = Effect.fn("LoopbackTunnel.listen")(function* (environmentId: string) {
    const existing = listeners.get(environmentId);
    const server = existing ?? NodeNet.createServer(accept(environmentId));
    if (existing === undefined) {
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
        catch: (cause) => new LoopbackTunnelRouteError({ environmentId, cause }),
      });
      listeners.set(environmentId, server);
    }
    return (server.address() as NodeNet.AddressInfo).port;
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
                // back out of that bypass. The order matters. A fixed proxy has no direct retry.
                proxyBypassRules: "*,<-loopback>",
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
