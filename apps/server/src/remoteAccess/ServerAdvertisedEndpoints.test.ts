import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import { assert, describe, it } from "@effect/vitest";

import { resolveServerAdvertisedEndpoints } from "./ServerAdvertisedEndpoints.ts";

const tailscaleProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
} as const;

const tailscaleIpEndpoint: AdvertisedEndpoint = createAdvertisedEndpoint({
  provider: tailscaleProvider,
  source: "server",
  id: "tailscale-ip:http://100.100.100.100:3773",
  label: "Tailscale IP",
  httpBaseUrl: "http://100.100.100.100:3773",
  reachability: "private-network",
});

const tailscaleServeEndpoint: AdvertisedEndpoint = createAdvertisedEndpoint({
  provider: tailscaleProvider,
  source: "server",
  id: "tailscale-magicdns:https://server.tail.ts.net/",
  label: "Tailscale HTTPS",
  httpBaseUrl: "https://server.tail.ts.net",
  reachability: "private-network",
});

describe("resolveServerAdvertisedEndpoints", () => {
  it("advertises only loopback (plus Tailscale Serve) under a loopback binding", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      port: 3773,
      host: undefined,
      networkInterfaces: {
        en0: [{ address: "192.168.1.44", family: "IPv4", internal: false }],
      },
      tailscaleEndpoints: [tailscaleIpEndpoint, tailscaleServeEndpoint],
    });

    // The LAN interface is not advertised: the server is not listening on it.
    assert.deepEqual(
      endpoints.map((endpoint) => endpoint.id),
      ["server-loopback:3773", tailscaleServeEndpoint.id],
    );
    const loopback = endpoints[0];
    assert.equal(loopback?.httpBaseUrl, "http://127.0.0.1:3773/");
    assert.equal(loopback?.wsBaseUrl, "ws://127.0.0.1:3773/");
    assert.equal(loopback?.reachability, "loopback");
    assert.equal(loopback?.source, "server");
    assert.equal(loopback?.provider.id, "server-core");
  });

  it("enumerates listening interfaces under a wildcard binding", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      port: 8080,
      host: "0.0.0.0",
      networkInterfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { address: "192.168.1.44", family: "IPv4", internal: false },
          { address: "10.4.0.9", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
        en1: [
          { address: "169.254.10.2", family: "IPv4", internal: false },
          { address: "203.0.113.7", family: "IPv4", internal: false },
          // Duplicated address is deduped.
          { address: "192.168.1.44", family: "IPv4", internal: false },
        ],
        tailscale0: [{ address: "100.100.100.100", family: "IPv4", internal: false }],
        docker0: [{ address: "127.0.0.5", family: "IPv4", internal: false }],
      },
      tailscaleEndpoints: [tailscaleIpEndpoint, tailscaleServeEndpoint],
    });

    assert.deepEqual(
      endpoints.map((endpoint) => [endpoint.id, endpoint.reachability]),
      [
        ["server-loopback:8080", "loopback"],
        ["server-lan:http://192.168.1.44:8080", "lan"],
        ["server-lan:http://10.4.0.9:8080", "lan"],
        ["server-public:http://203.0.113.7:8080", "public"],
        [tailscaleIpEndpoint.id, "private-network"],
        [tailscaleServeEndpoint.id, "private-network"],
      ],
    );
    // Only the first LAN endpoint is the default.
    assert.deepEqual(
      endpoints.filter((endpoint) => endpoint.isDefault === true).map((endpoint) => endpoint.id),
      ["server-lan:http://192.168.1.44:8080"],
    );
  });

  it("advertises only the bound host under a specific binding", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      port: 3773,
      host: "192.168.1.44",
      networkInterfaces: {
        en0: [{ address: "192.168.1.44", family: "IPv4", internal: false }],
      },
      // Tailscale Serve proxies to 127.0.0.1, which is not listening here.
      tailscaleEndpoints: [tailscaleIpEndpoint, tailscaleServeEndpoint],
    });

    assert.deepEqual(
      endpoints.map((endpoint) => endpoint.id),
      ["server-lan:http://192.168.1.44:3773"],
    );
    assert.equal(endpoints[0]?.reachability, "lan");
    assert.equal(endpoints[0]?.httpBaseUrl, "http://192.168.1.44:3773/");
  });

  it("classifies a bound Tailnet address as private-network", () => {
    const endpoints = resolveServerAdvertisedEndpoints({
      port: 3773,
      host: "100.100.100.100",
      networkInterfaces: {},
      tailscaleEndpoints: [],
    });

    assert.deepEqual(
      endpoints.map((endpoint) => [endpoint.id, endpoint.reachability]),
      [["server-private-network:http://100.100.100.100:3773", "private-network"]],
    );
  });
});
