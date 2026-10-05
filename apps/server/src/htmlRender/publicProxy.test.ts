// @effect-diagnostics nodeBuiltinImport:off - raw sockets speak SOCKS5 to the proxy.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { publicProxy } from "./publicProxy.ts";

// A public IPv4 address this machine holds, which no private range covers.
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

/** Sends a SOCKS5 greeting and CONNECT, and resolves with the reply code. */
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
      // Method selection (2 bytes) then the 10-byte reply.
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

/** `a.b.c.d` as the two hex groups of an IPv4-mapped IPv6 address. */
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
      const port = yield* publicProxy;
      for (const target of [
        ipv4Target("127.0.0.1", 80),
        ipv4Target("10.1.2.3", 80),
        ipv4Target("169.254.169.254", 80),
        domainTarget("localhost", 80),
      ]) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
      // Port 0 is not a connection target.
      const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 0));
      socket.destroy();
      expect(code).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses every address this machine holds, even a public one", () =>
    Effect.gen(function* () {
      const port = yield* publicProxy;
      const own = Object.values(NodeOS.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => !entry.internal && !entry.address.startsWith("fe80"));
      // IPv4 also as IPv4-mapped IPv6, which names the same host.
      const targets = own.flatMap((entry) =>
        entry.family === "IPv6"
          ? [ipv6Target(entry.address, 80)]
          : [ipv4Target(entry.address, 80), ipv6Target(`::ffff:${toHexPair(entry.address)}`, 80)],
      );
      for (const target of targets) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a request with a wrong version byte", () =>
    Effect.gen(function* () {
      const port = yield* publicProxy;
      const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 443), 4);
      socket.destroy();
      expect(code).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("closes every connection when its scope closes", () =>
    Effect.gen(function* () {
      const socket = yield* Effect.scoped(
        Effect.gen(function* () {
          const port = yield* publicProxy;
          return yield* Effect.callback<NodeNet.Socket>((resume) => {
            // A client mid-handshake, which the proxy must not wait on; closing
            // resets it.
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
});
