// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import {
  acceptsPrivateNetworkConnection,
  closeNonPrivateNetworkConnections,
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
