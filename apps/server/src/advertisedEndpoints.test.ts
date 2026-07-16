import { expect, it } from "@effect/vitest";

import { buildServerAdvertisedEndpoints } from "./advertisedEndpoints.ts";

it("advertises the tailscale endpoint as default ahead of the direct endpoint", () => {
  const endpoints = buildServerAdvertisedEndpoints({
    tailnetHttpsBaseUrl: "https://machine.tailnet.ts.net/",
    directHttpBaseUrl: "http://192.168.1.42:3773",
    directReachability: "lan",
  });

  expect(endpoints).toEqual([
    {
      id: "tailscale-serve",
      label: "Tailscale",
      provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: false },
      httpBaseUrl: "https://machine.tailnet.ts.net/",
      wsBaseUrl: "wss://machine.tailnet.ts.net/",
      reachability: "private-network",
      compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
      source: "server",
      status: "available",
      isDefault: true,
    },
    {
      id: "direct",
      label: "Direct",
      provider: { id: "direct", label: "Direct", kind: "core", isAddon: false },
      httpBaseUrl: "http://192.168.1.42:3773/",
      wsBaseUrl: "ws://192.168.1.42:3773/",
      reachability: "lan",
      compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
      source: "server",
      status: "available",
    },
  ]);
});

it("advertises only the direct endpoint when no tailnet base URL is recorded", () => {
  const endpoints = buildServerAdvertisedEndpoints({
    tailnetHttpsBaseUrl: null,
    directHttpBaseUrl: "http://localhost:3773",
    directReachability: "loopback",
  });

  expect(endpoints).toHaveLength(1);
  expect(endpoints[0]).toMatchObject({
    id: "direct",
    provider: { kind: "core" },
    reachability: "loopback",
  });
  expect(endpoints[0]).not.toHaveProperty("isDefault");
});
