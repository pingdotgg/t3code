import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const httpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
);

describe("tailscale endpoint provider", () => {
  it.effect("resolves Tailscale endpoints as add-on advertised endpoints", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        identity: { dnsNames: ["desktop.tail.ts.net", "desktop.second-tail.ts.net"] },
        networkInterfaces: {
          tailscale0: [
            {
              address: "100.100.100.100",
              family: "IPv4",
              internal: false,
              netmask: "255.192.0.0",
              cidr: "100.100.100.100/10",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      });
      assert.deepEqual(endpoints, [
        {
          id: "tailscale-ip:http://100.100.100.100:3773",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.100.100.100:3773/",
          wsBaseUrl: "ws://100.100.100.100:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
          description: "Reachable from devices on the same Tailnet.",
        },
        {
          id: "tailscale-magicdns:https://desktop.tail.ts.net/",
          label: "Tailscale HTTPS",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "https://desktop.tail.ts.net/",
          wsBaseUrl: "wss://desktop.tail.ts.net/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "requires-configuration",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "unavailable",
          description: "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
        },
        {
          id: "tailscale-magicdns:https://desktop.second-tail.ts.net/",
          label: "Tailscale HTTPS",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "https://desktop.second-tail.ts.net/",
          wsBaseUrl: "wss://desktop.second-tail.ts.net/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "requires-configuration",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "unavailable",
          description: "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
        },
      ]);
    }).pipe(Effect.provide(httpClientLayer)),
  );

  it.effect(
    "marks the Tailscale HTTPS endpoint available after Serve is enabled and reachable",
    () =>
      Effect.gen(function* () {
        const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
          port: 3773,
          networkInterfaces: {},
          identity: { dnsNames: ["desktop.tail.ts.net"] },
          serveEnabled: true,
          probe: () => Effect.succeed(true),
        });
        assert.deepEqual(endpoints, [
          {
            id: "tailscale-magicdns:https://desktop.tail.ts.net/",
            label: "Tailscale HTTPS",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.tail.ts.net/",
            wsBaseUrl: "wss://desktop.tail.ts.net/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "desktop-addon",
            status: "available",
            description: "HTTPS endpoint served by Tailscale Serve.",
          },
        ]);
      }).pipe(Effect.provide(httpClientLayer)),
  );
});
