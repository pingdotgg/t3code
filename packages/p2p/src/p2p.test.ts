import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import DHT from "hyperdht";
import createTestnet from "hyperdht/testnet";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { announceP2pEndpoint } from "./announcer.ts";
import { createP2pTunnel } from "./dialer.ts";
import { decodeP2pPublicKey, encodeP2pPublicKey, isValidP2pPublicKey } from "./keys.ts";

const TEST_TIMEOUT_MS = 30_000;

const acquireTestnetBootstrap = Effect.acquireRelease(
  Effect.promise(() => createTestnet(3)),
  (testnet) => Effect.promise(() => testnet.destroy()),
).pipe(Effect.map((testnet) => testnet.bootstrap.map(({ host, port }) => `${host}:${port}`)));

interface TestTcpServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const acquireTcpServer = (onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<TestTcpServer>((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        onConnection(socket);
      });
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.die(new Error("Failed to read the test server address.")));
          return;
        }
        const close = () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => resolve());
          });
        resume(Effect.succeed({ port: address.port, close }));
      });
    }),
    (testServer) => Effect.promise(() => testServer.close()),
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

const awaitDataThenClose = (port: number) =>
  Effect.callback<string>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", () => undefined);
    socket.on("close", () =>
      resume(
        received.length > 0
          ? Effect.succeed(received)
          : Effect.die(new Error("Socket closed without receiving any data.")),
      ),
    );
    socket.once("connect", () => {
      socket.write("x");
    });
  });

const randomSeed = () => Uint8Array.from(NodeCrypto.randomBytes(32));

describe("p2p", () => {
  it("derives a stable z32 address from a seed and round-trips it", () => {
    const seed = new Uint8Array(32).fill(7);
    const first = DHT.keyPair(Buffer.from(seed));
    const second = DHT.keyPair(Buffer.from(seed));
    const encoded = encodeP2pPublicKey(first.publicKey);
    assert.strictEqual(encodeP2pPublicKey(second.publicKey), encoded);

    const decoded = decodeP2pPublicKey(encoded);
    assert.isNotNull(decoded);
    assert.deepStrictEqual(Array.from(decoded), Array.from(first.publicKey));

    assert.isTrue(isValidP2pPublicKey(` ${encoded} `));
    assert.isFalse(isValidP2pPublicKey(""));
    assert.isFalse(isValidP2pPublicKey("not-a-key!"));
    assert.isFalse(isValidP2pPublicKey(encoded.slice(0, 10)));
  });

  it.effect(
    "announces on a local testnet and relays TCP round-trips",
    () =>
      Effect.gen(function* () {
        const bootstrap = yield* acquireTestnetBootstrap;
        const echo = yield* acquireTcpServer((socket) => {
          socket.pipe(socket);
        });
        const announcer = yield* announceP2pEndpoint({
          seed: randomSeed(),
          targetPort: echo.port,
          bootstrap,
          firewalled: false,
        });
        const tunnel = yield* createP2pTunnel({
          publicKeyZ32: announcer.publicKeyZ32,
          bootstrap,
        });
        const reply = yield* roundTrip(tunnel.localPort, "hello-p2p");
        assert.strictEqual(reply, "hello-p2p");
      }).pipe(Effect.scoped),
    TEST_TIMEOUT_MS,
  );

  it.effect(
    "propagates a remote close to the dialing socket",
    () =>
      Effect.gen(function* () {
        const bootstrap = yield* acquireTestnetBootstrap;
        const target = yield* acquireTcpServer((socket) => {
          socket.once("data", () => socket.end("bye"));
        });
        const announcer = yield* announceP2pEndpoint({
          seed: randomSeed(),
          targetPort: target.port,
          bootstrap,
          firewalled: false,
        });
        const tunnel = yield* createP2pTunnel({
          publicKeyZ32: announcer.publicKeyZ32,
          bootstrap,
        });
        const received = yield* awaitDataThenClose(tunnel.localPort);
        assert.strictEqual(received, "bye");
      }).pipe(Effect.scoped),
    TEST_TIMEOUT_MS,
  );

  it.effect("fails with a typed error on an invalid public key", () =>
    Effect.gen(function* () {
      const result = yield* createP2pTunnel({ publicKeyZ32: "definitely-invalid" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(result._tag, "P2pKeyDecodeError");
    }).pipe(Effect.scoped),
  );
});
