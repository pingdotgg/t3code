import type * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import {
  acceptsPrivateNetworkConnection,
  issueHeadlessServeAccessInfo,
  makeTailnetConnectionFilter,
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

it("prints the Tailscale address for a Tailscale-only listener, not another VPN's", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: {
        CloudflareWARP: [ipv4("100.96.0.2")],
        tailscale0: [ipv4("100.101.102.103")],
      },
      tailscaleOnly: true,
    }),
  ).toBe("http://100.101.102.103:3773");
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

describe("makeTailnetConnectionFilter", () => {
  const accepts = makeTailnetConnectionFilter({
    now: () => 0,
    readInterfaces: () => ({
      lo0: [ipv4("127.0.0.1", true)],
      // macOS names it utunN; Tailscale's IPv6 range identifies it.
      utun4: [
        ipv4("100.101.102.103"),
        {
          address: "fd7a:115c:a1e0::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fd7a:115c:a1e0::1/128",
          scopeid: 0,
        },
      ],
      CloudflareWARP: [ipv4("100.96.0.2")],
      en0: [ipv4("192.168.1.20")],
    }),
  });

  it.each([
    ["loopback", "127.0.0.1", "127.0.0.1", true],
    ["a tailnet peer", "100.101.102.103", "100.90.1.2", true],
    ["a mapped tailnet peer", "::ffff:100.101.102.103", "::ffff:100.90.1.2", true],
    ["a peer on another VPN's 100.64/10 address", "100.96.0.2", "100.90.1.2", false],
    ["a LAN peer", "192.168.1.20", "192.168.1.31", false],
    ["a LAN peer on the tailnet address", "100.101.102.103", "192.168.1.31", false],
    ["loopback reaching a LAN address", "192.168.1.20", "127.0.0.1", false],
    ["an unknown address", undefined, "100.90.1.2", false],
  ] as const)("serves %s: %s", (_name, localAddress, remoteAddress, expected) => {
    expect(accepts({ localAddress, remoteAddress })).toBe(expected);
  });

  it("picks up Tailscale coming up after the server started", () => {
    let now = 0;
    const interfaces: Record<string, Array<NodeOS.NetworkInterfaceInfo>> = {
      en0: [ipv4("192.168.1.20")],
    };
    const acceptsLater = makeTailnetConnectionFilter({
      now: () => now,
      readInterfaces: () => interfaces,
    });
    const peer = { localAddress: "100.101.102.103", remoteAddress: "100.90.1.2" };
    interfaces.tailscale0 = [ipv4("100.101.102.103")];
    expect(acceptsLater(peer)).toBe(false);
    now = 5_000;
    expect(acceptsLater(peer)).toBe(true);
  });
});

// regression: #25348 - the startup pairing link pointed at localhost after Serve published the server.
it.effect("advertises the Tailscale Serve HTTPS endpoint in headless pairing output", () =>
  Effect.gen(function* () {
    const baseConfig = yield* ServerConfig.ServerConfig;
    const servedUrl = "https://devbox.tail1234.ts.net";

    const accessInfo = yield* issueHeadlessServeAccessInfo().pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...baseConfig,
        port: 24783,
        host: undefined,
        startupPresentation: "headless",
        tailscaleServeEnabled: true,
        tailscaleServePort: 443,
      }),
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 24783),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Effect.provideService(
        EnvironmentAuth.EnvironmentAuth,
        EnvironmentAuth.EnvironmentAuth.of({
          issueStartupPairingCredential: () =>
            Effect.succeed({
              id: "startup",
              credential: "startup-token",
              expiresAt: DateTime.makeUnsafe(0),
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Effect.provideService(
        DirectEndpoints.DirectEndpoints,
        DirectEndpoints.DirectEndpoints.of({
          resolve: () =>
            Effect.succeed([
              { kind: "lan", httpBaseUrl: "http://192.168.1.42:24783/" },
              { kind: "tailnet", httpBaseUrl: `${servedUrl}/` },
            ]),
        }),
      ),
    );

    expect(accessInfo.connectionString).toBe(servedUrl);
    expect(accessInfo.pairingUrl).toBe(`${servedUrl}/pair#token=startup-token`);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-startup-access-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
