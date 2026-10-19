import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as NetService from "./Net.ts";

const closeServer = (server: NodeNet.Server) =>
  Effect.sync(() => {
    try {
      server.close();
    } catch {}
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

    it.effect.each(["EAFNOSUPPORT", "EADDRNOTAVAIL"])(
      "keeps ports available when IPv6 binds fail with %s",
      (code) =>
        Effect.gen(function* () {
          const net = yield* NetService.NetService;
          const port = yield* net.reserveLoopbackPort();
          const listen = NodeNet.Server.prototype.listen;
          const spy = vi.spyOn(NodeNet.Server.prototype, "listen").mockImplementation(function (
            this: NodeNet.Server,
            ...args
          ) {
            const [options] = args;
            if (options?.host === "::1" || options?.host === "::") {
              process.nextTick(() => this.emit("error", Object.assign(new Error(code), { code })));
              return this;
            }
            return listen.apply(this, args);
          });
          try {
            assert.equal(yield* net.isPortAvailableOnLoopback(port), true);
            assert.equal(yield* net.canListenOnHost(port, "::"), true);
          } finally {
            spy.mockRestore();
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
