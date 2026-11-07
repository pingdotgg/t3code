// @effect-diagnostics nodeBuiltinImport:off - raw sockets speak SOCKS5 to the proxy.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type * as NodeDns from "node:dns";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { publicProxy } from "./publicProxy.ts";

const OWN_PUBLIC_IPV4 = "198.51.100.7";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return {
    ...actual,
    networkInterfaces: () => ({
      ...actual.networkInterfaces(),
      "t3-test": [
        {
          address: OWN_PUBLIC_IPV4,
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: `${OWN_PUBLIC_IPV4}/24`,
        },
      ],
    }),
  };
});

// Clash and Mihomo answer every name from 198.18.0.0/16 in fake-IP mode.
// Effect code may not read process.env, so the swap stays a plain function.
const swapEgressProxyEnv = (value: string | undefined) => {
  const previous = process.env.T3CODE_PREVIEW_EGRESS_PROXY;
  if (value === undefined) delete process.env.T3CODE_PREVIEW_EGRESS_PROXY;
  else process.env.T3CODE_PREVIEW_EGRESS_PROXY = value;
  return () => {
    if (previous === undefined) delete process.env.T3CODE_PREVIEW_EGRESS_PROXY;
    else process.env.T3CODE_PREVIEW_EGRESS_PROXY = previous;
  };
};

const TEST_DNS: Record<string, ReadonlyArray<{ address: string; family: number }>> = {
  "cdn.fake-ip.test": [{ address: "198.18.2.40", family: 4 }],
  "mixed.fake-ip.test": [
    { address: "93.184.215.14", family: 4 },
    { address: "198.18.2.41", family: 4 },
  ],
};
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeDnsPromises>();
  return {
    ...actual,
    lookup: (host: string, options: NodeDns.LookupOptions) =>
      TEST_DNS[host] ? Promise.resolve(TEST_DNS[host]) : actual.lookup(host, options),
  };
});

const connectThrough = (proxyPort: number, target: Buffer, version = 5) =>
  Effect.callback<{ readonly code: number; readonly socket: NodeNet.Socket }>((resume) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1", () => {
      socket.write(Buffer.from([5, 1, 0]));
      socket.write(Buffer.concat([Buffer.from([version, 1, 0]), target]));
    });
    // The proxy may reset a refused connection.
    socket.on("error", () => {});
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 12) resume(Effect.succeed({ code: received[3]!, socket }));
    });
    socket.on("close", () => resume(Effect.succeed({ code: received[3] ?? -1, socket })));
  });

const ipv4Target = (address: string, port: number) => {
  const target = Buffer.alloc(7);
  target[0] = 1;
  address.split(".").forEach((octet, index) => (target[1 + index] = Number(octet)));
  target.writeUInt16BE(port, 5);
  return target;
};

const ipv6Target = (address: string, port: number) => {
  const target = Buffer.alloc(19);
  target[0] = 4;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  groups.forEach((group, index) => target.writeUInt16BE(Number.parseInt(group, 16), 1 + index * 2));
  target.writeUInt16BE(port, 17);
  return target;
};

const toHexPair = (address: string) => {
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

const domainTarget = (host: string, port: number) => {
  const name = Buffer.from(host, "latin1");
  const target = Buffer.alloc(4 + name.length);
  target[0] = 3;
  target[1] = name.length;
  name.copy(target, 2);
  target.writeUInt16BE(port, 2 + name.length);
  return target;
};

describe("publicProxy", () => {
  it.effect("refuses loopback and private targets, by address or by name", () =>
    Effect.gen(function* () {
      const { port } = yield* publicProxy;
      for (const target of [
        ipv4Target("127.0.0.1", 80),
        ipv4Target("10.1.2.3", 80),
        ipv4Target("169.254.169.254", 80),
        ipv4Target("198.18.0.1", 80),
        domainTarget("localhost", 80),
        ipv6Target("64:ff9b::7f00:1", 80),
        ipv6Target("64:ff9b::a00:1", 80),
        ipv6Target("2002:7f00:1::1", 80),
        ipv6Target("2001::1", 80),
        ipv6Target("::7f00:1", 80),
      ]) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
      const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 0));
      socket.destroy();
      expect(code).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses fake-IP names and records hosts whose every address is fake", () =>
    Effect.gen(function* () {
      const { port, fakeIpHosts } = yield* publicProxy;
      for (const host of ["cdn.fake-ip.test", "mixed.fake-ip.test"]) {
        const { code, socket } = yield* connectThrough(port, domainTarget(host, 443));
        socket.destroy();
        expect(code).toBe(2);
      }
      expect([...fakeIpHosts]).toEqual([["cdn.fake-ip.test", "198.18.2.40"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses every address this machine holds, even a public one", () =>
    Effect.gen(function* () {
      const { port } = yield* publicProxy;
      const own = Object.values(NodeOS.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => !entry.internal && !entry.address.startsWith("fe80"));
      const targets = own.flatMap((entry) =>
        entry.family === "IPv6"
          ? [ipv6Target(entry.address, 80)]
          : [
              ipv4Target(entry.address, 80),
              ipv6Target(`::ffff:${toHexPair(entry.address)}`, 80),
              ipv6Target(`64:ff9b::${toHexPair(entry.address)}`, 80),
            ],
      );
      for (const target of targets) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("closes every connection when its scope closes", () =>
    Effect.gen(function* () {
      const socket = yield* Effect.scoped(
        Effect.gen(function* () {
          const { port } = yield* publicProxy;
          return yield* Effect.callback<NodeNet.Socket>((resume) => {
            const client = NodeNet.connect(port, "127.0.0.1", () => {
              client.write(Buffer.from([5, 1, 0]));
              resume(Effect.succeed(client));
            });
            client.on("error", () => {});
          });
        }),
      );
      yield* Effect.callback<void>((resume) => {
        if (socket.closed) return resume(Effect.void);
        socket.once("close", () => resume(Effect.void));
      });
      expect(socket.closed).toBe(true);
    }),
  );

  describe("egress through the host proxy", () => {
    const withEnv = <A, E, R>(
      values: { readonly T3CODE_PREVIEW_EGRESS_PROXY?: string },
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => swapEgressProxyEnv(values.T3CODE_PREVIEW_EGRESS_PROXY)),
        () => effect,
        (restore) => Effect.sync(restore),
      );

    /** A fake egress proxy: records CONNECT lines, answers, then echoes. */
    const fakeEgress = (response: number | string) =>
      Effect.acquireRelease(
        Effect.callback<{
          readonly server: NodeNet.Server;
          readonly seen: Array<string>;
          readonly sockets: Set<NodeNet.Socket>;
        }>((resume) => {
          const seen: Array<string> = [];
          const sockets = new Set<NodeNet.Socket>();
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.on("error", () => {});
            let head = "";
            const onData = (chunk: Buffer) => {
              head += chunk.toString("latin1");
              const end = head.indexOf("\r\n\r\n");
              if (end === -1) return;
              socket.off("data", onData);
              seen.push(head.split("\r\n")[0]!);
              socket.write(
                typeof response === "number" ? `HTTP/1.1 ${response} X\r\n\r\n` : response,
              );
              if (typeof response === "number" && response !== 200) return void socket.end();
              const rest = head.slice(end + 4);
              if (rest) socket.write(rest);
              socket.on("data", (more) => socket.write(more));
            };
            socket.on("data", onData);
          });
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, seen, sockets })));
        }),
        ({ server, sockets }) =>
          Effect.callback<void>((resume) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resume(Effect.void));
          }),
      );

    const portOf = (server: NodeNet.Server) => (server.address() as NodeNet.AddressInfo).port;

    it.live.each(["client disconnect", "scope shutdown"] as const)(
      "closes an unfinished CONNECT on %s",
      (reason) =>
        Effect.gen(function* () {
          const requested = Promise.withResolvers<void>();
          const closed = Promise.withResolvers<void>();
          let upstream: NodeNet.Socket | undefined;
          let client: NodeNet.Socket | undefined;
          const server = NodeNet.createServer((socket) => {
            upstream = socket;
            socket.on("error", () => {});
            socket.once("close", () => closed.resolve());
            socket.once("data", () => requested.resolve());
          });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          try {
            yield* withEnv(
              { T3CODE_PREVIEW_EGRESS_PROXY: `http://127.0.0.1:${portOf(server)}` },
              Effect.gen(function* () {
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const { port } = yield* publicProxy;
                    client = NodeNet.connect(port, "127.0.0.1", () => {
                      client!.write(Buffer.from([5, 1, 0]));
                      client!.write(
                        Buffer.concat([Buffer.from([5, 1, 0]), ipv4Target("1.1.1.1", 443)]),
                      );
                    });
                    client.on("error", () => {});
                    client.on("data", () => {});
                    yield* Effect.promise(() => requested.promise);
                    if (reason === "client disconnect") {
                      client.destroy();
                      yield* Effect.promise(() => closed.promise);
                    }
                  }),
                );
                yield* Effect.promise(() => closed.promise);
              }),
            );
          } finally {
            client?.destroy();
            upstream?.destroy();
            yield* Effect.promise(
              () => new Promise<void>((resolve) => server.close(() => resolve())),
            );
          }
        }),
    );

    it.effect("tunnels a public target through the egress proxy and never dials it directly", () =>
      Effect.gen(function* () {
        const { server, seen } = yield* fakeEgress(200);
        yield* withEnv(
          { T3CODE_PREVIEW_EGRESS_PROXY: `http://127.0.0.1:${portOf(server)}` },
          Effect.gen(function* () {
            const { port } = yield* publicProxy;
            const { code, socket } = yield* connectThrough(port, domainTarget("1.1.1.1", 443));
            expect(code).toBe(0);
            const echoed = yield* Effect.callback<string>((resume) => {
              socket.once("data", (chunk) => resume(Effect.succeed(chunk.toString())));
              socket.write("ping");
            });
            socket.destroy();
            expect(echoed).toBe("ping");
            expect(seen).toEqual(["CONNECT 1.1.1.1:443 HTTP/1.1"]);
          }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("refuses when the egress proxy refuses the destination", () =>
      Effect.gen(function* () {
        const { server, seen } = yield* fakeEgress(403);
        yield* withEnv(
          { T3CODE_PREVIEW_EGRESS_PROXY: `http://127.0.0.1:${portOf(server)}` },
          Effect.gen(function* () {
            const { port } = yield* publicProxy;
            const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 443));
            socket.destroy();
            expect(code).toBe(5);
            expect(seen).toEqual(["CONNECT 1.1.1.1:443 HTTP/1.1"]);
          }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect.each([
      ["another successful status", "HTTP/1.1 201 Created\r\n\r\n", 0],
      ["informational response", "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n", 0],
      [
        "informational then refusal",
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 403 Forbidden\r\n\r\n",
        5,
      ],
      [
        "oversized informational headers",
        `${`HTTP/1.1 103 Early Hints\r\nX: ${"x".repeat(9 * 1024)}\r\n\r\n`.repeat(2)}HTTP/1.1 200 OK\r\n\r\n`,
        5,
      ],
      ["malformed status", "HTTP/1.1 200evil\r\n\r\n", 5],
      ["oversized complete headers", `HTTP/1.1 200 OK\r\nX: ${"x".repeat(16 * 1024)}\r\n\r\n`, 5],
      ["oversized incomplete headers", `HTTP/1.1 200 OK\r\nX: ${"x".repeat(16 * 1024)}`, 5],
      ["large tunnel data", `HTTP/1.1 200 OK\r\n\r\n${"x".repeat(16 * 1024)}`, 0],
    ] as const)("handles %s in CONNECT responses", ([_name, response, expected]) =>
      Effect.gen(function* () {
        const { server } = yield* fakeEgress(response);
        yield* withEnv(
          { T3CODE_PREVIEW_EGRESS_PROXY: `http://127.0.0.1:${portOf(server)}` },
          Effect.gen(function* () {
            const { port } = yield* publicProxy;
            const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 443));
            socket.destroy();
            expect(code).toBe(expected);
          }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("refuses rather than dialing directly when the proxy setting is unusable", () =>
      Effect.gen(function* () {
        for (const value of [
          "socks5://127.0.0.1:1",
          "http://user:pass@127.0.0.1:1",
          "not a url",
          "",
          "   ",
        ]) {
          yield* withEnv(
            { T3CODE_PREVIEW_EGRESS_PROXY: value },
            Effect.gen(function* () {
              const { port } = yield* publicProxy;
              const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 443));
              socket.destroy();
              expect(code).toBe(2);
            }),
          ).pipe(Effect.scoped);
        }
      }),
    );
  });
});
