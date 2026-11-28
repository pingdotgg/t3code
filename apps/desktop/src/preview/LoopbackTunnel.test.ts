import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

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
const listenDecoyOn = (host: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeNet.Server; connections: () => number }>((resolve, reject) => {
          let connections = 0;
          const server = NodeNet.createServer((socket) => {
            connections++;
            socket.destroy();
          });
          server.once("error", reject);
          server.listen(0, host, () => resolve({ server, connections: () => connections }));
        }),
    ),
    ({ server }) => closeServer(server),
  );
const listenDecoy = listenDecoyOn("127.0.0.1");

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

type HostLayer =
  | Layer.Layer<FileSystem.FileSystem>
  | Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
  | Layer.Layer<never>;

/** The tunnel service, with every access request answered with `tunnelUrl`. */
const makeTunnel = (
  /** A function answers each access request with its current value. */
  tunnelUrl: string | null | (() => string | null),
  host?: HostLayer,
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
            host ?? Layer.empty,
            SecureRandom.layerWebCrypto,
            NetService.layer,
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
    const tunnel = Context.get(services, LoopbackTunnel.LoopbackTunnel);
    yield* Queue.take(accessRequests).pipe(
      Effect.flatMap((requestId) =>
        tunnel.resolveAccess({
          requestId,
          url: typeof tunnelUrl === "function" ? tunnelUrl() : tunnelUrl,
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    return tunnel;
  });

/** Routes a stand-in session through the tunnel and returns its SOCKS listener port. */
const routeThroughTunnel = (tunnelUrl: string | null, host?: HostLayer) =>
  Effect.gen(function* () {
    const tunnel = yield* makeTunnel(tunnelUrl, host);
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
  { case: "no TCP row and no user id to compare", host: "localhost", tunnel: "no-user-id" },
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
          : tunnel === "no-user-id"
            ? Layer.mergeAll(
                Layer.succeed(HostProcess.Platform, "linux"),
                Layer.succeed(HostProcess.UserId, undefined),
                tcpTablesWithMovedAddress(1),
              )
            : undefined,
    );
    const { reply } = yield* socksConnect(proxyPort, host, addressPort(decoy.server));
    expect(reply[1]).not.toBe(0);
    expect(endpoint.requests).toEqual([]);
    expect(decoy.connections()).toBe(0);
  }),
);

/** Stands in for the system's own tools: each command prints what `print` returns for it. */
const systemTools = (print: (command: string, args: ReadonlyArray<string>) => string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const { command: name, args } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(print(name, args))),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

const ownUserId = process.getuid?.() ?? 501;

it.effect.each([
  { client: "own", served: true },
  { client: "another user's", served: false },
  { client: "unlisted", served: false },
] as const)(
  "serves a SOCKS client on macOS only when the system lists it as this user's: $client",
  ({ client, served }) =>
    Effect.gen(function* () {
      const decoy = yield* listenDecoy;
      const endpoint = yield* listenEndpoint;
      const commands: Array<string> = [];
      let proxyPort = 0;
      const lsof = (args: ReadonlyArray<string>) => {
        const clientEnd = /^-iTCP@(.+)$/.exec(args[1] ?? "")?.[1];
        // The listener's accepted socket is this app's own and is always listed.
        const accepted = `p100\nu${ownUserId}\nf30\nn127.0.0.1:${proxyPort}->${clientEnd}\n`;
        if (client === "unlisted") return accepted;
        const owner = client === "own" ? ownUserId : ownUserId + 1;
        return `${accepted}p200\nu${owner}\nf12\nn${clientEnd}->127.0.0.1:${proxyPort}\n`;
      };
      proxyPort = yield* routeThroughTunnel(
        `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel`,
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.UserId, ownUserId),
          systemTools((command, args) => {
            commands.push(command);
            return command === "/usr/sbin/lsof" ? lsof(args) : "";
          }),
        ),
      );
      const { reply } = yield* socksConnect(proxyPort, "localhost", addressPort(decoy.server));
      expect(reply[1] === 0).toBe(served);
      expect(endpoint.requests.length).toBe(served ? 1 : 0);
      expect(decoy.connections()).toBe(0);
      expect(commands).toEqual(["/usr/sbin/lsof"]);
    }),
);

it.effect("serves a SOCKS client on Windows without looking up its owner", () =>
  Effect.gen(function* () {
    const decoy = yield* listenDecoy;
    const endpoint = yield* listenEndpoint;
    const commands: Array<string> = [];
    const proxyPort = yield* routeThroughTunnel(
      `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel`,
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.UserId, undefined),
        systemTools((command) => {
          commands.push(command);
          return "";
        }),
      ),
    );
    const { reply } = yield* socksConnect(proxyPort, "localhost", addressPort(decoy.server));
    expect(reply[1]).toBe(0);
    expect(endpoint.requests.length).toBe(1);
    expect(decoy.connections()).toBe(0);
    expect(commands).toEqual([]);
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

/** Connects to a local port, sends `bytes`, and resolves with the first chunk back. */
const exchange = (port: number, bytes: Uint8Array) =>
  Effect.promise(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const socket = NodeNet.connect(port, "127.0.0.1", () => socket.write(bytes));
        socket.once("data", (chunk) => {
          resolve([...chunk]);
          socket.destroy();
        });
        socket.on("error", reject);
      }),
  );

const refusesConnections = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = NodeNet.connect(port, "127.0.0.1", () => {
          socket.destroy();
          resolve(false);
        });
        socket.on("error", () => resolve(true));
      }),
  );

it.effect("forwards a port over the tunnel on the same local port until stopped", () =>
  Effect.gen(function* () {
    const endpoint = yield* listenEndpoint;
    const remotePort = yield* unusedPort;
    const tunnel = yield* makeTunnel(
      `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel?wsTicket=t`,
    );
    const announced: number[][] = [];
    yield* tunnel.subscribeForwards((forwards) =>
      Effect.sync(() => announced.push(forwards.map((forward) => forward.localPort))),
    );
    const environmentId = EnvironmentId.make("remote");
    const forward = yield* tunnel.forward({ environmentId, remotePort });
    expect(forward).toEqual({ environmentId, remotePort, localPort: remotePort });

    expect(yield* exchange(remotePort, Uint8Array.of(4, 5))).toEqual([0xee, 4, 5]);
    // The first request is the same-machine probe.
    expect(endpoint.requests.at(-1)).toBe(`/api/preview/tunnel?wsTicket=t&port=${remotePort}`);

    yield* tunnel.stopForward({ environmentId, remotePort });
    expect(yield* refusesConnections(remotePort)).toBe(true);
    expect(yield* tunnel.forwards).toEqual([]);
    expect(announced).toEqual([[remotePort], []]);
  }),
);

const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = NodeNet.createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

// Vite listens on ::1 by default on macOS, and Node's default listen is ::.
it.effect.each(hasIpv6Loopback ? ["127.0.0.1", "::1", "::"] : ["127.0.0.1"])(
  "moves a forward to a free port when its own is taken here on %s",
  (host) =>
    Effect.gen(function* () {
      const decoy = yield* listenDecoyOn(host);
      const endpoint = yield* listenEndpoint;
      const remotePort = addressPort(decoy.server);
      const tunnel = yield* makeTunnel(
        `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel`,
      );
      const forward = yield* tunnel.forward({
        environmentId: EnvironmentId.make("remote"),
        remotePort,
      });
      expect(forward.localPort).not.toBe(remotePort);

      expect(yield* exchange(forward.localPort, Uint8Array.of(6))).toEqual([0xee, 6]);
      expect(endpoint.requests.at(-1)).toBe(`/api/preview/tunnel?port=${remotePort}`);
      expect(decoy.connections()).toBe(0);
    }),
);

/** An environment on this machine: each tunnel connection dials the requested local port. */
const listenSameMachineEndpoint = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeWS.WebSocketServer>((resolve) => {
        const server: NodeWS.WebSocketServer = new NodeWS.WebSocketServer(
          { port: 0, host: "127.0.0.1" },
          () => resolve(server),
        );
        server.on("connection", (socket: NodeWS.WebSocket, request: { url?: string }) => {
          const port = Number(new URL(request.url ?? "", "ws://x").searchParams.get("port"));
          const local = NodeNet.connect(port, "127.0.0.1");
          local.on("data", (chunk) => socket.send(chunk));
          local.on("error", () => socket.close());
          socket.on("message", (data: Buffer) => local.write(data));
          socket.on("close", () => local.destroy());
        });
      }),
  ),
  closeServer,
);

it.effect("refuses to forward from an environment that shares this machine's loopback", () =>
  Effect.gen(function* () {
    const endpoint = yield* listenSameMachineEndpoint;
    const remotePort = yield* unusedPort;
    const tunnel = yield* makeTunnel(`ws://127.0.0.1:${addressPort(endpoint)}/api/preview/tunnel`);
    const error = yield* tunnel
      .forward({ environmentId: EnvironmentId.make("remote"), remotePort })
      .pipe(Effect.flip);
    expect(error._tag).toBe("LoopbackTunnelSameMachineError");
    expect(yield* refusesConnections(remotePort)).toBe(true);
    expect(yield* tunnel.forwards).toEqual([]);
  }),
);

it.effect(
  "forwards nothing while the environment is out of reach, then forwards once it is back",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* listenEndpoint;
      const remotePort = yield* unusedPort;
      let access: string | null = null;
      const tunnel = yield* makeTunnel(() => access);
      const environmentId = EnvironmentId.make("remote");

      const unavailable = yield* tunnel.forward({ environmentId, remotePort }).pipe(Effect.flip);
      expect(unavailable._tag).toBe("LoopbackTunnelUnavailableError");
      expect(yield* refusesConnections(remotePort)).toBe(true);
      expect(yield* tunnel.forwards).toEqual([]);

      access = `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel`;
      const forward = yield* tunnel.forward({ environmentId, remotePort });
      expect(yield* exchange(forward.localPort, Uint8Array.of(9))).toEqual([0xee, 9]);
    }),
);

/** The environment's tunnel route refusing every port with a 502, as for a port nothing listens on. */
const listenRefusingEndpoint = (headers: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeWS.WebSocketServer>((resolve) => {
          const server: NodeWS.WebSocketServer = new NodeWS.WebSocketServer(
            {
              port: 0,
              host: "127.0.0.1",
              verifyClient: (_info, done) => done(false, 502, "Bad Gateway", headers),
            },
            () => resolve(server),
          );
        }),
    ),
    closeServer,
  );

it.effect.each([
  { case: "the environment reports nothing on the probe port", refused: true },
  { case: "the tunnel fails for another reason", refused: false },
])("decides a forward's machine only on proof: $case", ({ refused }) =>
  Effect.gen(function* () {
    const endpoint = yield* listenRefusingEndpoint(
      refused ? { "x-t3-tunnel-port-refused": "1" } : {},
    );
    const remotePort = yield* unusedPort;
    const tunnel = yield* makeTunnel(`ws://127.0.0.1:${addressPort(endpoint)}/api/preview/tunnel`);
    const result = yield* tunnel
      .forward({ environmentId: EnvironmentId.make("remote"), remotePort })
      .pipe(Effect.result);
    if (refused) {
      expect(Result.isSuccess(result)).toBe(true);
    } else {
      expect(Result.isFailure(result) && result.failure._tag).toBe(
        "LoopbackTunnelUnavailableError",
      );
      expect(yield* refusesConnections(remotePort)).toBe(true);
    }
  }),
);

it.effect("closes connections beyond a forward's limit without tunnelling them", () =>
  Effect.gen(function* () {
    const endpoint = yield* listenEndpoint;
    const tunnel = yield* makeTunnel(
      `ws://127.0.0.1:${addressPort(endpoint.server)}/api/preview/tunnel`,
    );
    const forward = yield* tunnel.forward({
      environmentId: EnvironmentId.make("remote"),
      remotePort: yield* unusedPort,
    });
    const open = () =>
      Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeNet.Socket>((resolve) => {
              const socket = NodeNet.connect(forward.localPort, "127.0.0.1", () => {
                socket.once("data", () => resolve(socket));
                socket.write(Uint8Array.of(1));
              });
            }),
        ),
        (socket) => Effect.sync(() => socket.destroy()),
      );
    yield* Effect.forEach(Array.from({ length: 64 }), open, { concurrency: "unbounded" });
    const tunnelled = endpoint.requests.length;
    const closed = yield* Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = NodeNet.connect(forward.localPort, "127.0.0.1");
          socket.on("error", () => {});
          socket.on("close", () => resolve(true));
          socket.on("data", () => resolve(false));
          socket.write(Uint8Array.of(2));
        }),
    );
    expect(closed).toBe(true);
    expect(endpoint.requests.length).toBe(tunnelled);
  }),
);
