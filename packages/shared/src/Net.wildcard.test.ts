import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { make } from "./Net.ts";

const addresses = Object.values(NodeOS.networkInterfaces()).flatMap((entries) => entries ?? []);
const lan = addresses.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
const hasIpv6Loopback = addresses.some((entry) => entry.address === "::1");

const openServer = (host: string | undefined, port = 0) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeNet.Server>((resolve, reject) => {
          const server = NodeNet.createServer();
          server.once("error", reject);
          server.listen({ port, host }, () => resolve(server));
        }),
    ),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  ).pipe(
    Effect.map((server) => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Expected a TCP address");
      return address.port;
    }),
  );

describe("wildcard port selection", () => {
  it.effect.skipIf(!hasIpv6Loopback)(
    "avoids an IPv6 loopback listener for an IPv4 wildcard bind",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* openServer("::1");
          const selected = yield* make().findAvailablePort(occupied, "0.0.0.0");
          expect(selected).not.toBe(occupied);
        }),
      ),
  );

  for (const { name, skip, occupiedHost, requestedHost, bindHost } of [
    {
      name: "treats an empty host as a wildcard bind",
      skip: lan === undefined,
      occupiedHost: lan,
      requestedHost: "",
      bindHost: "",
    },
    {
      name: "accepts bracketed IPv6 wildcard hosts",
      skip: !hasIpv6Loopback,
      occupiedHost: "::1",
      requestedHost: "[::]",
      bindHost: "::",
    },
  ]) {
    it.effect.skipIf(skip)(name, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* openServer(occupiedHost);
          const selected = yield* make().findAvailablePort(occupied, requestedHost);
          expect(selected).not.toBe(occupied);
          expect(yield* openServer(bindHost, selected)).toBe(selected);
        }),
      ),
    );
  }

  it.effect.skipIf(lan === undefined || !hasIpv6Loopback)(
    "allocates fallback ports on the wildcard and retries a loopback collision",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lanPort = yield* openServer(lan);
          const loopbackPort = yield* openServer("::1");
          const listen = NodeNet.Server.prototype.listen;
          let firstWildcard = true;
          const spy = vi.spyOn(NodeNet.Server.prototype, "listen").mockImplementation(function (
            this: NodeNet.Server,
            ...args
          ) {
            // Control the OS choice for port zero while keeping the actual socket binds.
            const [port, host, callback]: readonly unknown[] = args;
            if (port === 0 && host === "127.0.0.1") {
              return Reflect.apply(listen, this, [lanPort, host, callback]);
            }
            if (port === 0 && host === "0.0.0.0" && firstWildcard) {
              firstWildcard = false;
              return Reflect.apply(listen, this, [loopbackPort, host, callback]);
            }
            return listen.apply(this, args);
          });
          try {
            const selected = yield* make().findAvailablePort(0, "0.0.0.0");
            expect(selected).toBeGreaterThan(0);
            expect(selected).not.toBe(lanPort);
            expect(selected).not.toBe(loopbackPort);
            expect(yield* openServer("0.0.0.0", selected)).toBe(selected);
          } finally {
            spy.mockRestore();
          }
        }),
      ),
  );
});
