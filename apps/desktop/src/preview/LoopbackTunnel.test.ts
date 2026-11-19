import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as LoopbackTunnel from "./LoopbackTunnel.ts";

const addressPort = (server: NodeNet.Server | NodeWS.WebSocketServer) =>
  (server.address() as NodeNet.AddressInfo).port;

const closeServer = (server: NodeNet.Server | NodeWS.WebSocketServer) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (server instanceof NodeWS.WebSocketServer) {
          for (const client of server.clients) client.terminate();
        }
        server.close(() => resolve());
      }),
  );

/** A local listener that must never see a connection: the reviewer's own localhost server. */
const listenDecoy = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: NodeNet.Server; connections: () => number }>((resolve) => {
        let connections = 0;
        const server = NodeNet.createServer((socket) => {
          connections++;
          socket.destroy();
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, connections: () => connections }));
      }),
  ),
  ({ server }) => closeServer(server),
);

/** Stands in for the environment's /api/preview/tunnel: echoes each frame behind a 0xee byte. */
const listenEndpoint = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: NodeWS.WebSocketServer; requests: string[] }>((resolve) => {
        const requests: string[] = [];
        const server: NodeWS.WebSocketServer = new NodeWS.WebSocketServer(
          { port: 0, host: "127.0.0.1" },
          () => resolve({ server, requests }),
        );
        server.on("connection", (socket: NodeWS.WebSocket, request: { url?: string }) => {
          requests.push(request.url ?? "");
          socket.on("message", (data: Buffer) =>
            socket.send(Buffer.concat([Uint8Array.of(0xee), data])),
          );
        });
      }),
  ),
  ({ server }) => closeServer(server),
);

const unusedPort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = addressPort(server);
        server.close(() => resolve(port));
      });
    }),
);

/** Routes a stand-in session through the tunnel and returns its SOCKS listener port. */
const routeThroughTunnel = (
  tunnelUrl: string | null,
  host?: Layer.Layer<FileSystem.FileSystem> | Layer.Layer<never>,
) =>
  Effect.gen(function* () {
    const accessRequests = yield* Queue.unbounded<string>();
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, request: { readonly requestId: string }) =>
          Queue.offerUnsafe(accessRequests, request.requestId),
      },
    };
    const services = yield* Layer.build(
      LoopbackTunnel.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ElectronWindow.ElectronWindow, {
              currentMainOrFirst: Effect.succeedSome(window as unknown as Electron.BrowserWindow),
            }),
            NodeFileSystem.layer,
            host ?? Layer.empty,
          ),
        ),
      ),
    );
    const tunnel = Context.get(services, LoopbackTunnel.LoopbackTunnel);
    yield* Queue.take(accessRequests).pipe(
      Effect.flatMap((requestId) => tunnel.resolveAccess({ requestId, url: tunnelUrl })),
      Effect.forever,
      Effect.forkScoped,
    );
    let proxyRules = "";
    const session = {
      setProxy: async (config: Electron.ProxyConfig) => {
        proxyRules = config.proxyRules ?? "";
      },
      closeAllConnections: async () => undefined,
      webRequest: { onBeforeRequest: () => undefined },
    };
    yield* tunnel.route({
      environmentId: "remote",
      session: session as unknown as Electron.Session,
      tunnelled: true,
    });
    return Number(/socks5:\/\/127\.0\.0\.1:(\d+)/.exec(proxyRules)![1]);
  });

/**
 * The real TCP tables with 127.0.0.1 in one column rewritten to 127.0.0.2. The rows keep their
 * ports and owner, so only an address mismatch can refuse them.
 */
const tcpTablesWithMovedAddress = (column: 1 | 2) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const moveAddress = (line: string) => {
        const columns = line.trim().split(/\s+/);
        const address = columns[column];
        if (address === undefined || !/0100007F:/i.test(address)) return line;
        columns[column] = address.replace(/0100007F:/i, "0200007F:");
        return columns.join(" ");
      };
      return FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (path, encoding) =>
          fileSystem
            .readFileString(path, encoding)
            .pipe(Effect.map((table) => table.split("\n").map(moveAddress).join("\n"))),
      });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

/** Greets the SOCKS listener and sends a CONNECT for `host:port`; resolves with the reply. */
const socksConnect = (proxyPort: number, host: string, port: number) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ socket: NodeNet.Socket; reply: Buffer }>((resolve, reject) => {
          const socket = NodeNet.connect(proxyPort, "127.0.0.1", () =>
            socket.write(Uint8Array.of(5, 1, 0)),
          );
          let received = Buffer.alloc(0);
          let greeted = false;
          const onData = (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            if (!greeted && received.length >= 2) {
              // A refused greeting is the whole answer.
              if (received[1] !== 0) return resolve({ socket, reply: received.subarray(0, 2) });
              greeted = true;
              received = received.subarray(2);
              const destination = Buffer.alloc(2);
              destination.writeUInt16BE(port);
              socket.write(
                Buffer.concat([
                  Uint8Array.of(5, 1, 0, 3, host.length),
                  Buffer.from(host, "latin1"),
                  destination,
                ]),
              );
            }
            if (greeted && received.length >= 10) {
              socket.off("data", onData);
              resolve({ socket, reply: received.subarray(0, 10) });
            }
          };
          socket.on("data", onData);
          socket.on("error", reject);
        }),
    ),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );

it.effect.each(["localhost", "localhost."])(
  "carries a loopback CONNECT for %s over the tunnel WebSocket, not to local listeners",
  (host) =>
    Effect.gen(function* () {
      const decoy = yield* listenDecoy;
      const endpoint = yield* listenEndpoint;
      const proxyPort = yield* routeThroughTunnel(
        `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel?wsTicket=t`,
      );
      const { socket, reply } = yield* socksConnect(proxyPort, host, addressPort(decoy.server));
      expect(reply[1]).toBe(0);
      const echoed = yield* Effect.promise(
        () =>
          new Promise<number[]>((resolve) => {
            socket.once("data", (chunk) => resolve([...chunk]));
            socket.write(Uint8Array.of(1, 2, 3));
          }),
      );
      expect(echoed).toEqual([0xee, 1, 2, 3]);
      expect(endpoint.requests).toEqual([
        `/api/preview/tunnel?wsTicket=t&port=${addressPort(decoy.server)}`,
      ]);
      expect(decoy.connections()).toBe(0);
    }),
);

it.effect.each([
  { case: "a non-loopback destination", host: "192.168.1.20", tunnel: "endpoint" },
  { case: "no tunnel URL", host: "127.0.0.1", tunnel: "none" },
  { case: "an unreachable tunnel endpoint", host: "localhost", tunnel: "unreachable" },
  { case: "another OS user's client", host: "localhost", tunnel: "other-user" },
  { case: "a TCP row whose client address differs", host: "localhost", tunnel: "moved-client" },
  { case: "a TCP row whose listener address differs", host: "localhost", tunnel: "moved-listener" },
] as const)("fails the SOCKS request for $case without dialling locally", ({ host, tunnel }) =>
  Effect.gen(function* () {
    const decoy = yield* listenDecoy;
    const endpoint = yield* listenEndpoint;
    const endpointPort =
      tunnel === "unreachable" ? yield* unusedPort : addressPort(endpoint.server);
    const proxyPort = yield* routeThroughTunnel(
      tunnel === "none" ? null : `ws://127.0.0.1:${endpointPort}/api/preview/tunnel`,
      // This process owns the client, so a different user id here makes it another user's.
      tunnel === "other-user"
        ? Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.UserId, (process.getuid?.() ?? 0) + 1),
          )
        : tunnel === "moved-client" || tunnel === "moved-listener"
          ? Layer.mergeAll(
              Layer.succeed(HostProcess.Platform, "linux"),
              tcpTablesWithMovedAddress(tunnel === "moved-client" ? 1 : 2),
            )
          : undefined,
    );
    const { reply } = yield* socksConnect(proxyPort, host, addressPort(decoy.server));
    expect(reply[1]).not.toBe(0);
    expect(endpoint.requests).toEqual([]);
    expect(decoy.connections()).toBe(0);
  }),
);

it.effect("connects straight to the environment's own forwarded origin port", () =>
  Effect.gen(function* () {
    // Over SSH the origin is a local forward, and signed file previews load from it.
    const received: number[] = [];
    const origin = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer((socket) =>
              socket.on("data", (chunk) => {
                received.push(...chunk);
                socket.write(chunk);
              }),
            );
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      closeServer,
    );
    const port = addressPort(origin);
    const proxyPort = yield* routeThroughTunnel(`ws://127.0.0.1:${port}/api/preview/tunnel`);
    const { socket, reply } = yield* socksConnect(proxyPort, "127.0.0.1", port);
    expect(reply[1]).toBe(0);
    const echoed = yield* Effect.promise(
      () =>
        new Promise<number[]>((resolve) => {
          socket.once("data", (chunk) => resolve([...chunk]));
          socket.write(Uint8Array.of(7, 8));
        }),
    );
    expect(echoed).toEqual([7, 8]);
    expect(received).toEqual([7, 8]);
  }),
);
