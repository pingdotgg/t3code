// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NetAddress from "effect/net/NetAddress";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import {
  acceptsPrivateNetworkConnection,
  closeNonPrivateNetworkConnections,
  headlessServeOutput,
  loopbackUrlHostForAddress,
  resolveHeadlessConnectionString,
  resolveLocalOrigin,
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
    platform: "linux",
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

  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces, platform: "linux" })).toBe(
    "http://203.0.113.7:3773",
  );
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces,
      privateNetworkOnly: true,
      platform: "linux",
    }),
  ).toBe("http://10.0.0.5:3773");
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { eth0: [ipv4("203.0.113.7")] },
      privateNetworkOnly: true,
      platform: "linux",
    }),
  ).toBe("http://127.0.0.1:3773");
});

it("names the bound loopback address instead of localhost", () => {
  const options = { interfaces: {}, platform: "linux" as const };
  expect(resolveHeadlessConnectionString(undefined, 3773, options)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::", 3773, options)).toBe("http://[::1]:3773");
  expect(resolveLocalOrigin(undefined, 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveLocalOrigin("0.0.0.0", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveLocalOrigin("[::]", 3773)).toBe("http://[::1]:3773");
  expect(resolveLocalOrigin("192.168.1.42", 3773)).toBe("http://192.168.1.42:3773");
});

it("prefers a LAN address over a tailnet one for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { tailscale0: [ipv4("100.101.102.103")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
      platform: "linux",
    }),
  ).toBe("http://192.168.1.42:3773");
});

it("skips a VPN tunnel address for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { utun40: [ipv4("198.19.2.2")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
      platform: "darwin",
    }),
  ).toBe("http://192.168.1.42:3773");
});

it("skips Windows VirtualBox and VMware host-only adapters for a private-network listener", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: {
        "VirtualBox Host-Only Network": [{ ...ipv4("192.168.56.1"), mac: "0a:00:27:00:00:0a" }],
        "VMware Network Adapter VMnet8": [{ ...ipv4("192.168.159.1"), mac: "00:50:56:c0:00:08" }],
        "Wi-Fi": [{ ...ipv4("192.168.1.20"), mac: "3c:22:fb:12:34:56" }],
      },
      privateNetworkOnly: true,
      platform: "win32",
    }),
  ).toBe("http://192.168.1.20:3773");
});

it("skips NixOS container and systemd-nspawn veths for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { "ve-jellyfin": [ipv4("192.168.53.193")], eth0: [ipv4("192.168.0.18")] },
      privateNetworkOnly: true,
      platform: "linux",
    }),
  ).toBe("http://192.168.0.18:3773");
});

it("targets the bound interface when the listener binds a specific address", () => {
  const hostFor = (ip: string) =>
    loopbackUrlHostForAddress(NetAddress.inetAddressFromIpStringUnsafe(ip, 3773));

  expect(hostFor("0.0.0.0")).toBe("127.0.0.1");
  expect(hostFor("::")).toBe("127.0.0.1");
  expect(hostFor("::1")).toBe("[::1]");
  expect(hostFor("127.0.0.1")).toBe("127.0.0.1");
  expect(hostFor("127.0.0.2")).toBe("127.0.0.2");
  expect(hostFor("100.101.102.103")).toBe("100.101.102.103");
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

describe("closeNonPrivateNetworkConnections", () => {
  it.effect("logs the local and remote address of a connection it closes", () =>
    Effect.gen(function* () {
      const warnings: Array<Logger.Options<unknown>> = [];
      const server = NodeHttp.createServer();
      yield* closeNonPrivateNetworkConnections(server).pipe(
        Effect.provide(
          Logger.layer([Logger.make((entry) => warnings.push(entry))], {
            mergeWithExisting: false,
          }),
        ),
      );

      // An unconnected socket: Node reports neither address.
      const socket = new NodeNet.Socket();
      server.emit("connection", socket);

      expect(socket.destroyed).toBe(true);
      expect(warnings.map((entry) => entry.logLevel)).toEqual(["Warn"]);
      const line = Logger.formatLogFmt.log(warnings[0]!);
      expect(line).toMatch(/localAddress\W+undefined/);
      expect(line).toMatch(/remoteAddress\W+undefined/);
    }),
  );

  it.effect("logs a flood of closed connections at most once a minute, with a count", () =>
    Effect.gen(function* () {
      const warnings: Array<Logger.Options<unknown>> = [];
      const server = NodeHttp.createServer();
      yield* closeNonPrivateNetworkConnections(server).pipe(
        Effect.provide(
          Logger.layer([Logger.make((entry) => warnings.push(entry))], {
            mergeWithExisting: false,
          }),
        ),
      );
      const sockets = Array.from({ length: 1000 }, () => new NodeNet.Socket());
      for (const socket of sockets) server.emit("connection", socket);
      yield* TestClock.adjust("1 minute");
      server.emit("connection", new NodeNet.Socket());

      expect(sockets.every((socket) => socket.destroyed)).toBe(true);
      expect(warnings).toHaveLength(2);
      expect(Logger.formatLogFmt.log(warnings[1]!)).toMatch(/closedSinceLastLog\W+999/);
    }),
  );
});

describe("headlessServeOutput", () => {
  const output = (serviceManaged: boolean) =>
    Effect.gen(function* () {
      let issued = 0;
      const text = yield* headlessServeOutput({ serviceManaged }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              issueStartupPairingCredential: () =>
                Effect.sync(() => {
                  issued += 1;
                  return {
                    id: "startup",
                    credential: "FIXTURECODE1",
                    expiresAt: DateTime.makeUnsafe("2026-01-01T00:05:00Z"),
                  };
                }),
            }),
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
            }),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-startup-access-test-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
      return { text, issued };
    });

  it.effect("prints pairing details for a server run in a terminal", () =>
    Effect.gen(function* () {
      const { text, issued } = yield* output(false);
      expect(issued).toBe(1);
      expect(text).toContain("Token: FIXTURECODE1");
      expect(text).toContain("#token=FIXTURECODE1");
    }),
  );

  it.effect("prints the address and the pair command for the background service", () =>
    Effect.gen(function* () {
      const { text, issued } = yield* output(true);
      expect(issued).toBe(0);
      expect(text).not.toContain("oken");
      expect(text).toBe(
        [
          "T3 Code server is ready.",
          "Connection string: http://127.0.0.1:3773",
          "Run `t3 pair` on this machine to connect a device.",
          "",
        ].join("\n"),
      );
    }),
  );
});
