import { assert, describe, it } from "@effect/vitest";
import { announceP2pEndpoint } from "@t3tools/p2p/announcer";
import { createLocalDhtTestnet } from "@t3tools/p2p/testing";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as DesktopP2pEnvironment from "./DesktopP2pEnvironment.ts";

const TEST_TIMEOUT_MS = 30_000;

const acquireTestnetBootstrap = Effect.acquireRelease(
  Effect.promise(() => createLocalDhtTestnet(3)),
  (testnet) => Effect.promise(() => testnet.destroy()),
).pipe(Effect.map((testnet) => testnet.bootstrap));

const acquireEchoServer = Effect.acquireRelease(
  Effect.callback<{ port: number; close: () => Promise<void> }>((resume) => {
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    server.once("error", (error) => resume(Effect.die(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(Effect.die(new Error("Failed to read the echo server address.")));
        return;
      }
      resume(
        Effect.succeed({
          port: address.port,
          close: () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets) {
                socket.destroy();
              }
              server.close(() => resolve());
            }),
        }),
      );
    });
  }),
  (echo) => Effect.promise(() => echo.close()),
);

const roundTrip = (port: number, message: string) =>
  Effect.callback<string>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.length >= message.length) {
        socket.destroy();
        resume(Effect.succeed(received));
      }
    });
    socket.on("error", (error) => resume(Effect.die(error)));
    socket.once("connect", () => {
      socket.write(message);
    });
  });

const expectConnectionRefused = (port: number) =>
  Effect.callback<void>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("error", () => resume(Effect.void));
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.die(new Error("Expected the closed tunnel port to refuse connections.")));
    });
  });

const portOf = (httpBaseUrl: string): number => Number(new URL(httpBaseUrl).port);

describe("DesktopP2pEnvironment", () => {
  it.effect(
    "dials by public key, reuses live tunnels, and tears down on disconnect",
    () =>
      Effect.gen(function* () {
        const bootstrap = yield* acquireTestnetBootstrap;
        const echo = yield* acquireEchoServer;
        const announcer = yield* announceP2pEndpoint({
          seed: Uint8Array.from(NodeCrypto.randomBytes(32)),
          targetPort: echo.port,
          bootstrap,
          firewalled: false,
        });

        const p2p = yield* DesktopP2pEnvironment.make;
        const input = { publicKeyZ32: announcer.publicKeyZ32, bootstrap };

        const endpoint = yield* p2p.ensureEnvironment(input);
        const reply = yield* roundTrip(portOf(endpoint.httpBaseUrl), "hello-desktop");
        assert.strictEqual(reply, "hello-desktop");

        const reused = yield* p2p.ensureEnvironment(input);
        assert.strictEqual(reused.httpBaseUrl, endpoint.httpBaseUrl);

        yield* p2p.disconnectEnvironment(announcer.publicKeyZ32);
        yield* expectConnectionRefused(portOf(endpoint.httpBaseUrl));
      }).pipe(Effect.scoped),
    TEST_TIMEOUT_MS,
  );

  it.effect("fails with a typed error for an invalid public key", () =>
    Effect.gen(function* () {
      const p2p = yield* DesktopP2pEnvironment.make;
      const error = yield* p2p
        .ensureEnvironment({ publicKeyZ32: "not-a-key", bootstrap: [] })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "DesktopP2pEnvironmentError");
    }).pipe(Effect.scoped),
  );
});
