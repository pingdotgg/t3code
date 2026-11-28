import * as NodeNet from "node:net";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

import * as NetService from "./Net.ts";

const hosts = [
  { host: "::", address: "::" },
  { host: "[::]", address: "::" },
  { host: "::1", address: "::1" },
  { host: "[::1]", address: "::1" },
];

const cases = hosts.flatMap(({ host, address }) =>
  ["EAFNOSUPPORT", "EADDRNOTAVAIL"].flatMap((code) =>
    (address === "::1" ? [3773, 0] : [3773]).map((preferred) => ({
      host,
      address,
      code,
      preferred,
    })),
  ),
);

it.layer(NetService.layer)("Automatic port selection", (it) => {
  it.effect.each(cases)(
    "rejects $host on $code with preferred port $preferred",
    ({ host, address, code, preferred }) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const bindError = Object.assign(new Error(code), { code });
        const connect = vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (
          this: NodeNet.Socket,
        ) {
          process.nextTick(() => this.emit("error", new Error("ECONNREFUSED")));
          return this;
        });
        const originalListen = NodeNet.Server.prototype.listen;
        const listen = vi.spyOn(NodeNet.Server.prototype, "listen").mockImplementation(function (
          this: NodeNet.Server,
          ...args
        ) {
          const [options, positionalHost] = args;
          const bindHost = typeof options === "number" ? positionalHost : options?.host;
          if (bindHost === "::" || bindHost === "::1") {
            const cause =
              bindHost === address ? bindError : Object.assign(new Error(code), { code });
            process.nextTick(() => this.emit("error", cause));
            return this;
          }
          if (options?.host === "127.0.0.1") {
            process.nextTick(() => this.emit("listening"));
            return this;
          }
          return originalListen.apply(this, args);
        });
        try {
          const error = yield* net.findAvailablePort(preferred, host).pipe(
            Effect.match({
              onSuccess: () => undefined,
              onFailure: (error) => error,
            }),
          );
          if (preferred === 0) {
            expect(error?.cause).toBe(bindError);
          } else {
            expect(error?.cause).toMatchObject({ host: address, port: preferred, code });
            expect(error?.cause).toHaveProperty("cause", bindError);
          }
        } finally {
          listen.mockRestore();
          connect.mockRestore();
        }
      }),
  );

  it.effect("skips an IPv6 loopback reservation held on IPv4 loopback", () =>
    Effect.acquireUseRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve, reject) => {
            const server = NodeNet.createServer();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (occupied) =>
        Effect.gen(function* () {
          const net = yield* NetService.NetService;
          const address = occupied.address();
          if (address === null || typeof address === "string") {
            throw new Error("Expected an IPv4 loopback listener");
          }

          const originalListen = NodeNet.Server.prototype.listen;
          const offeredPorts: number[] = [];
          const listen = vi.spyOn(NodeNet.Server.prototype, "listen").mockImplementation(function (
            this: NodeNet.Server,
            ...args
          ) {
            const bindArguments: readonly unknown[] = args;
            const [port, host] = bindArguments;
            if (port === 0 && host === "::1") {
              const readAddress = this.address.bind(this);
              vi.spyOn(this, "address").mockImplementationOnce(() => {
                const assigned = readAddress();
                if (assigned === null || typeof assigned === "string") {
                  throw new Error("Expected an ephemeral port");
                }
                const offeredPort = offeredPorts.length === 0 ? address.port : assigned.port;
                offeredPorts.push(offeredPort);
                return { address: "::1", family: "IPv6", port: offeredPort };
              });
              // Simulate IPv6 allocation even on machines without IPv6 support.
              return Reflect.apply(originalListen, this, [port, "127.0.0.1", ...args.slice(2)]);
            }
            return originalListen.apply(this, args);
          });
          try {
            const selected = yield* net.findAvailablePort(0, "::1");
            expect(offeredPorts[0]).toBe(address.port);
            expect(offeredPorts.slice(1)).toContain(selected);
            expect(selected).not.toBe(address.port);
          } finally {
            listen.mockRestore();
          }
        }),
      (occupied) =>
        Effect.sync(() => {
          occupied.close();
        }),
    ),
  );
});
