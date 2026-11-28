import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

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

const ownIpv4 = Object.values(NodeOS.networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;

it.layer(NetService.layer)("NetService", (it) => {
  describe("Net helpers", () => {
    it.effect.each(["EAFNOSUPPORT", "EADDRNOTAVAIL"])(
      "keeps optional IPv6 probes available on %s while failing explicit bind hosts",
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
            if (
              options?.host === "::1" ||
              options?.host === "::" ||
              options?.host === "192.0.2.123" ||
              options?.host === "2001:db8::1"
            ) {
              process.nextTick(() => this.emit("error", Object.assign(new Error(code), { code })));
              return this;
            }
            return listen.apply(this, args);
          });
          try {
            assert.equal(yield* net.isPortAvailableOnLoopback(port), true);
            assert.equal(yield* net.canListenOnHost(port, "::"), true);
            for (const host of ["192.0.2.123", "2001:db8::1"]) {
              assert.equal(yield* net.canListenOnHost(port, host), false);
              const error = yield* net.probeListenOnHost(port, host).pipe(Effect.flip);
              assert.deepStrictEqual(
                [error._tag, error.host, error.code],
                ["NetListenError", host, code],
              );
            }
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
            assert.notEqual(yield* net.findAvailablePort(preferred, ownIpv4), preferred);
          }),
        closeServer,
      ),
    );

    for (const host of ["0.0.0.0", ""]) {
      it.effect.skipIf(ownIpv4 === undefined)(
        `findAvailablePort skips a port a LAN listener holds for wildcard host "${host}"`,
        () =>
          Effect.acquireUseRelease(
            openServer(ownIpv4),
            (server) =>
              Effect.gen(function* () {
                const net = yield* NetService.NetService;
                const selected = yield* net.findAvailablePort(getPort(server), host);
                assert.notEqual(selected, getPort(server));
                assert.equal(yield* net.canListenOnHost(selected, "0.0.0.0"), true);
              }),
            closeServer,
          ),
      );
    }

    it.effect.skipIf(ownIpv4 === undefined)(
      "findAvailablePort keeps a port that only loopback uses for a specific bind address",
      () =>
        Effect.acquireUseRelease(
          openServer("127.0.0.1"),
          (server) =>
            Effect.gen(function* () {
              const net = yield* NetService.NetService;
              const preferred = getPort(server);

              assert.equal(yield* net.findAvailablePort(preferred, ownIpv4), preferred);
              assert.notEqual(yield* net.findAvailablePort(preferred, "0.0.0.0"), preferred);
            }),
          closeServer,
        ),
    );
  });
});
