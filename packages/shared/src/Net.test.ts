import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as NetService from "./Net.ts";

const isLoopbackPortListenError = Schema.is(NetService.LoopbackPortListenError);
const isLoopbackPortAddressUnavailableError = Schema.is(
  NetService.LoopbackPortAddressUnavailableError,
);
const isLoopbackPortReleaseError = Schema.is(NetService.LoopbackPortReleaseError);

const closeServer = (server: NodeNet.Server) =>
  Effect.sync(() => {
    try {
      server.close();
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

const getPort = (server: NodeNet.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const openServer = (host?: string): Effect.Effect<NodeNet.Server, Error> =>
  Effect.callback<NodeNet.Server, Error>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<NodeNet.Server, Error>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.once("error", (cause) => {
      settle(Effect.fail(cause));
    });

    if (host) {
      server.listen(0, host, () => settle(Effect.succeed(server)));
    } else {
      server.listen(0, () => settle(Effect.succeed(server)));
    }

    return closeServer(server);
  });

it.layer(NetService.layer)("NetService", (it) => {
  describe("Net helpers", () => {
    it.effect("reserveLoopbackPort returns a positive loopback port", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const port = yield* net.reserveLoopbackPort();

        assert.ok(port > 0);
      }),
    );

    it.effect("retains the host and listen cause when reservation fails", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const error = yield* net.reserveLoopbackPort("256.256.256.256").pipe(Effect.flip);

        assert(isLoopbackPortListenError(error));
        assert.equal(error.host, "256.256.256.256");
        assert.match(error.message, /256\.256\.256\.256/u);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTFOUND");
      }),
    );

    it.effect("classifies server errors during close as release failures", () => {
      const probe = NodeNet.createServer();
      const cause = new Error("close failed");
      probe.unref = (() => probe) as typeof probe.unref;
      probe.address = (() => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 43123,
      })) as typeof probe.address;
      probe.listen = ((_port: number, _host: string, listeningListener: () => void) => {
        listeningListener();
        return probe;
      }) as typeof probe.listen;
      probe.close = (() => {
        probe.emit("error", cause);
        return probe;
      }) as typeof probe.close;
      const net = NetService.make({ createServer: () => probe });

      return Effect.gen(function* () {
        const error = yield* net.reserveLoopbackPort().pipe(Effect.flip);

        assert(isLoopbackPortReleaseError(error));
        assert.equal(error.host, "127.0.0.1");
        assert.equal(error.port, 43123);
        assert.strictEqual(error.cause, cause);
      });
    });

    it.effect("preserves address context when an unusable reservation errors during close", () =>
      Effect.gen(function* () {
        for (const invalidPort of [null, 43.5, 65_536]) {
          const probe = NodeNet.createServer();
          const cause = new Error("close failed");
          probe.unref = (() => probe) as typeof probe.unref;
          probe.address = (() => ({
            address: "127.0.0.1",
            family: "IPv4",
            port: invalidPort,
          })) as unknown as typeof probe.address;
          probe.listen = ((_port: number, _host: string, listeningListener: () => void) => {
            listeningListener();
            return probe;
          }) as typeof probe.listen;
          probe.close = (() => {
            probe.emit("error", cause);
            return probe;
          }) as typeof probe.close;
          const net = NetService.make({ createServer: () => probe });

          const error = yield* net.reserveLoopbackPort().pipe(Effect.flip);

          assert(isLoopbackPortAddressUnavailableError(error));
          assert.equal(error.host, "127.0.0.1");
          assert.equal(error.address, "127.0.0.1");
          assert.equal(error.family, "IPv4");
          assert.equal(error.port, invalidPort);
          assert.strictEqual(error.cause, cause);
        }
      }),
    );

    it.effect("rejects missing and non-finite ports returned by the server", () =>
      Effect.gen(function* () {
        for (const invalidPort of [undefined, Number.NaN]) {
          const probe = NodeNet.createServer();
          probe.unref = (() => probe) as typeof probe.unref;
          probe.address = (() => ({
            address: "127.0.0.1",
            family: "IPv4",
            port: invalidPort,
          })) as unknown as typeof probe.address;
          probe.listen = ((_port: number, _host: string, listeningListener: () => void) => {
            listeningListener();
            return probe;
          }) as typeof probe.listen;
          probe.close = ((callback?: (cause?: Error) => void) => {
            callback?.();
            return probe;
          }) as typeof probe.close;
          const net = NetService.make({ createServer: () => probe });

          const error = yield* net.reserveLoopbackPort().pipe(Effect.flip);

          assert(isLoopbackPortAddressUnavailableError(error));
          assert.equal(error.port, null);
          assert.equal("cause" in error, false);
        }
      }),
    );

    it.effect("isPortAvailableOnLoopback reports false for an occupied port", () =>
      Effect.acquireUseRelease(
        openServer("127.0.0.1"),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService.NetService;
            const port = getPort(server);

            const available = yield* net.isPortAvailableOnLoopback(port);
            assert.equal(available, false);
          }),
        closeServer,
      ),
    );

    it.effect("findAvailablePort returns preferred when it is free", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const preferred = yield* net.reserveLoopbackPort();

        const resolved = yield* net.findAvailablePort(preferred);
        assert.equal(resolved, preferred);
      }),
    );

    it.effect("findAvailablePort falls back when a wildcard listener occupies IPv4", () =>
      Effect.acquireUseRelease(
        openServer("0.0.0.0"),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService.NetService;
            const preferred = getPort(server);

            const resolved = yield* net.findAvailablePort(preferred);
            assert.ok(resolved > 0);
            assert.notEqual(resolved, preferred);
          }),
        closeServer,
      ),
    );
  });
});
