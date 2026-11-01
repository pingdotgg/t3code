import type * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Path from "effect/Path";
import { HttpServer } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import {
  acceptsPrivateNetworkConnection,
  announceHeadlessAccess,
  resolveHeadlessConnectionString,
} from "./startupAccess.ts";

const ipv4 = (address: string, internal = false): NodeOS.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    interfaces: { en0: [ipv4("192.168.1.42")], lo0: [ipv4("127.0.0.1", true)] },
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("skips public and container addresses for a private-network listener", () => {
  const interfaces = {
    eth0: [ipv4("203.0.113.7")],
    docker0: [ipv4("172.17.0.1")],
    bridge200: [ipv4("192.168.64.1")],
    eth1: [ipv4("10.0.0.5")],
  };

  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces })).toBe(
    "http://203.0.113.7:3773",
  );
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces, privateNetworkOnly: true }),
  ).toBe("http://10.0.0.5:3773");
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { eth0: [ipv4("203.0.113.7")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://localhost:3773");
});

it("prefers a LAN address over a tailnet one for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { tailscale0: [ipv4("100.101.102.103")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://192.168.1.42:3773");
});

describe("acceptsPrivateNetworkConnection", () => {
  const accepts = (localAddress: string | undefined, remoteAddress: string | undefined) =>
    acceptsPrivateNetworkConnection({ localAddress, remoteAddress });

  it("serves loopback, LAN, and tailnet clients", () => {
    expect(accepts("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(accepts("::ffff:192.168.1.20", "::ffff:192.168.1.31")).toBe(true);
    expect(accepts("100.101.102.103", "100.90.1.2")).toBe(true);
  });

  it("closes connections from or to a public address", () => {
    // A cloud VM's public address is NATed to a private interface address.
    expect(accepts("172.31.4.10", "203.0.113.7")).toBe(false);
    expect(accepts("203.0.113.7", "192.168.1.31")).toBe(false);
    expect(accepts("169.254.10.1", "169.254.10.2")).toBe(false);
    expect(accepts(undefined, "192.168.1.31")).toBe(false);
  });
});

it.effect.each([
  { serviceManaged: false, baseDir: "/home/u/.t3", issued: 1, printsToken: true, hint: "" },
  {
    serviceManaged: true,
    baseDir: "/home/u/.t3",
    issued: 0,
    printsToken: false,
    hint: "Run `t3 pair` to pair a device.",
  },
  {
    serviceManaged: true,
    baseDir: "/srv/it's t3",
    issued: 0,
    printsToken: false,
    hint: "Run `t3 pair --base-dir '/srv/it'\\''s t3'` to pair a device.",
  },
])(
  "prints a startup pairing token only outside the background service: %o",
  ({ serviceManaged, baseDir, issued, printsToken, hint }) =>
    Effect.gen(function* () {
      const printed: Array<string> = [];
      let issuedCount = 0;
      yield* announceHeadlessAccess({ serviceManaged }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerConfig.ServerConfig)({
              host: "127.0.0.1",
              port: 3773,
              privateNetworkOnly: false,
              baseDir,
            } as never),
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
            }),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              issueStartupPairingCredential: () =>
                Effect.sync(() => {
                  issuedCount += 1;
                  return {
                    id: "startup",
                    credential: "startup-secret",
                    expiresAt: DateTime.makeUnsafe(0),
                  };
                }),
            }),
            Path.layer,
          ),
        ),
        Effect.provideService(HostProcess.HomeDirectory, "/home/u"),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            printed.push(NodeUtil.format(...args));
          },
        }),
      );
      expect(issuedCount).toBe(issued);
      expect(printed.join("\n").includes("startup-secret")).toBe(printsToken);
      expect(printed.join("\n").includes(hint)).toBe(true);
    }),
);
