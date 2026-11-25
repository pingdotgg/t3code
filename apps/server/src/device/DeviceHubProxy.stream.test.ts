import { expect, it } from "@effect/vitest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { layerMediaSocketTest } from "../auth/secureSocket.testkit.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { SecureChannelError, SecureChannelIdentity } from "@t3tools/shared/secureChannel";
import { SECURE_CHANNEL_CLOSE_CODE } from "@t3tools/shared/secureChannelSocket";
import { makeSecureSocketKeys } from "../auth/secureSocket.testkit.ts";

const bearerSession: EnvironmentAuth.AuthenticatedSession = {
  sessionId: AuthSessionId.make("test"),
  subject: "test",
  method: "bearer-access-token",
  scopes: [AuthOrchestrationOperateScope],
};

/** An echoing hub that first sends 0x83, behind the real proxy route. */
const serveHubProxy = Effect.fnUntraced(function* (
  session: EnvironmentAuth.AuthenticatedSession = bearerSession,
  identity?: Effect.Effect<SecureChannelIdentity, SecureChannelError>,
) {
  const hub = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) client.terminate();
            server.close(() => resolve());
          }),
      ),
  );
  if (!hub.address())
    yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
  const address = hub.address();
  if (typeof address !== "object" || !address) throw new Error("Missing hub port");
  const upstreamClosed = Promise.withResolvers<void>();
  hub.on("connection", (socket) => {
    socket.once("close", upstreamClosed.resolve);
    socket.send(Uint8Array.of(0x83));
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  const invalidated = yield* Deferred.make<void>();
  const services = yield* Layer.build(
    HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(layerMediaSocketTest(identity)),
      Layer.provide(
        Layer.mock(SessionStore.SessionStore, {
          cookieName: "test",
          legacyCookieName: undefined,
          awaitInvalidation: () => Deferred.await(invalidated),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () => Effect.succeed(session),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provide(
        Layer.succeed(DeviceService.DeviceService, {
          currentReadiness: () =>
            Effect.succeed({
              hostId: LOCAL_DEVICE_HOST_ID,
              hub: { origin: `http://127.0.0.1:${address.port}` },
            }),
        } as DeviceService.DeviceService["Service"]),
      ),
    ),
  );
  const origin = HttpServer.formatAddress(
    Context.get(services, HttpServer.HttpServer).address,
  ).replace(/^http/, "ws");
  return { origin, invalidated, upstreamClosed };
});

it.effect("preserves binary input and admission frames through the real socket proxy", () =>
  Effect.gen(function* () {
    const { origin, invalidated, upstreamClosed } = yield* serveHubProxy();
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(
            `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test`,
          ),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    client.binaryType = "arraybuffer";
    const frames: number[][] = [];
    const received = Promise.withResolvers<void>();
    client.addEventListener("error", () => received.reject(new Error("Proxy failed")));
    client.addEventListener("message", ({ data }) => {
      frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
      if (frames.length === 1) {
        client.send(Uint8Array.of(0x03, 1));
        client.send(Uint8Array.of(0x03, 2));
      } else if (frames.length === 3) received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    expect(frames).toEqual([[0x83], [0x03, 1], [0x03, 2]]);

    const closed = new Promise<void>((resolve) =>
      client.addEventListener("close", () => resolve(), { once: true }),
    );
    yield* Deferred.succeed(invalidated, undefined);
    yield* Effect.promise(() => Promise.all([closed, upstreamClosed.promise]));
  }),
);

it.live("closes an upstream socket that is still connecting without an unhandled error", () =>
  Effect.gen(function* () {
    const dialed = Promise.withResolvers<NodeNet.Socket>();
    // Accepts the connection and never answers the WebSocket handshake.
    const hub = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer((socket) => dialed.resolve(socket));
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    // Handshake headers, as Simlock's routes send, select the `ws` package over the global WebSocket.
    const upstream = yield* Socket.makeWebSocket(`ws://127.0.0.1:${address.port}`, {
      headers: { authorization: "Bearer test" },
    }).pipe(Effect.provide(DeviceHubProxy.upstreamWebSocketConstructor));
    const reading = yield* Effect.forkChild(
      Effect.scoped(Effect.flatMap(upstream.reader, ({ pull }) => pull)),
    );
    const connection = yield* Effect.promise(() => dialed.promise);
    const abandoned = new Promise<void>((resolve) => connection.once("close", () => resolve()));
    connection.resume();
    yield* Fiber.interrupt(reading);
    yield* Effect.promise(() => abandoned);
  }),
);

it.live("runs a socket that asked for it inside the secure channel and forwards plaintext", () =>
  Effect.gen(function* () {
    const keys = yield* makeSecureSocketKeys;
    const { origin } = yield* serveHubProxy(
      keys.session([AuthOrchestrationOperateScope]),
      Effect.succeed(keys.environment),
    );
    const socket = yield* keys.connect(
      `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test`,
    );
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    expect(yield* reader.pull).toEqual([Uint8Array.of(0x83)]);
    yield* writer.writeAll([Uint8Array.of(0x03, 1), "text"]);
    const echoed: Array<Uint8Array | string> = [];
    while (echoed.length < 2) echoed.push(...(yield* reader.pull));
    expect(echoed).toEqual([Uint8Array.of(0x03, 1), "text"]);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.live("refuses a secure socket whose query was changed on the way", () =>
  Effect.gen(function* () {
    const keys = yield* makeSecureSocketKeys;
    const { origin } = yield* serveHubProxy(
      keys.session([AuthOrchestrationOperateScope]),
      Effect.succeed(keys.environment),
    );
    const url = `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test`;
    const socket = yield* keys.connect(url, url.replace("device=test", "device=other"));
    const error = yield* Effect.flip(Effect.flatMap(socket.reader, ({ pull }) => pull));
    expect(error.reason._tag === "SocketCloseError" ? error.reason.code : undefined).toBe(
      SECURE_CHANNEL_CLOSE_CODE,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.live("closes a plaintext client on a socket whose proof asked for the secure channel", () =>
  Effect.gen(function* () {
    const keys = yield* makeSecureSocketKeys;
    const { origin } = yield* serveHubProxy(
      keys.session([AuthOrchestrationOperateScope]),
      Effect.succeed(keys.environment),
    );
    const socket = yield* Socket.makeWebSocket(
      `${origin}/api/device-hub/vendor/serve-sim/helper/ws?device=test&wsTicket=test`,
    ).pipe(Effect.provide(NodeWS.layerWebSocketConstructor));
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    yield* writer.write(Uint8Array.of(0x03, 1));
    const error = yield* Effect.flip(reader.pull);
    expect(error.reason._tag === "SocketCloseError" ? error.reason.code : undefined).toBe(
      SECURE_CHANNEL_CLOSE_CODE,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
