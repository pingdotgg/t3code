import { expect, it } from "@effect/vitest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

// serve-emu's control frames (its `reset-video`) are JSON sent as a TEXT
// WebSocket frame, and serve-emu ignores a binary one. The proxy must not
// change the frame type on the way through.
it.effect("keeps a client text frame as text for the upstream hub", () =>
  Effect.gen(function* () {
    const received: Array<{ bytes: string; isBinary: boolean }> = [];
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
    hub.on("connection", (socket) => {
      socket.send(Uint8Array.of(0x83));
      socket.on("message", (data, isBinary) => {
        received.push({ bytes: Buffer.from(data as Buffer).toString("utf8"), isBinary });
        socket.send(data, { binary: isBinary });
      });
    });
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes: [AuthOrchestrationOperateScope],
              }),
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
    const echoed = Promise.withResolvers<void>();
    client.addEventListener("error", () => echoed.reject(new Error("Proxy failed")));
    client.addEventListener("message", ({ data }) => {
      if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 0x83) {
        client.send('{"type":"reset-video","ack":false}');
      } else {
        echoed.resolve();
      }
    });
    yield* Effect.promise(() => echoed.promise);
    const control = received.find((entry) => entry.bytes.includes("reset-video"));
    expect(control).toBeDefined();
    expect(control?.isBinary).toBe(false);
  }),
);
