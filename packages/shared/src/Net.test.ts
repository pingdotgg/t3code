import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as NetService from "./Net.ts";

const listenInterceptor = vi.hoisted(() => ({
  failHost: null as string | null,
  errorCode: "EAFNOSUPPORT",
}));

// Fails `listen({ host })` for one host with a chosen errno, e.g. EAFNOSUPPORT
// for `::` on a kernel booted with `ipv6.disable=1`, which CI hosts are not.
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const listen = server.listen.bind(server) as (...a: Array<unknown>) => NodeNet.Server;
      server.listen = ((...listenArgs: Array<unknown>) => {
        const [options] = listenArgs;
        if (
          listenInterceptor.failHost !== null &&
          typeof options === "object" &&
          options !== null &&
          (options as NodeNet.ListenOptions).host === listenInterceptor.failHost
        ) {
          const error = new Error(`listen ${listenInterceptor.errorCode}`);
          Object.assign(error, { code: listenInterceptor.errorCode });
          process.nextTick(() => server.emit("error", error));
          return server;
        }
        return listen(...listenArgs);
      }) as typeof server.listen;
      return server;
    },
  };
});

const withListenError = <A, E, R>(
  host: string,
  errorCode: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.sync(() => {
    listenInterceptor.failHost = host;
    listenInterceptor.errorCode = errorCode;
  }).pipe(
    Effect.andThen(effect),
    Effect.ensuring(
      Effect.sync(() => {
        listenInterceptor.failHost = null;
      }),
    ),
  );

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

const openServer = (host?: string): Effect.Effect<NodeNet.Server, NetService.NetError> =>
  Effect.callback<NodeNet.Server, NetService.NetError>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<NodeNet.Server, NetService.NetError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.once("error", (cause) => {
      settle(
        Effect.fail(new NetService.NetError({ message: "Failed to open test server", cause })),
      );
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

    it.effect("canListenOnHost treats a host without IPv6 support as available", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const port = yield* net.reserveLoopbackPort();

        const available = yield* withListenError(
          "::",
          "EAFNOSUPPORT",
          net.canListenOnHost(port, "::"),
        );
        assert.equal(available, true);
      }),
    );

    it.effect("canListenOnHost reports other bind errors as unavailable", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const port = yield* net.reserveLoopbackPort();

        const available = yield* withListenError("::", "EACCES", net.canListenOnHost(port, "::"));
        assert.equal(available, false);
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
