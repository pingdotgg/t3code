import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import {
  parseTailscaleMagicDnsName,
  resolveTailscaleAdvertisedEndpoints,
} from "./tailscaleEndpointProvider.ts";

const layerUnusedTailscaleExternalServices = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected tailscale status process")),
  ),
);

const protonAndTailscaleInterfaces = {
  pvpnksintrf1: [{ address: "100.85.0.1", family: "IPv4", internal: false }],
  tailscale0: [{ address: "100.74.126.34", family: "IPv4", internal: false }],
};

describe("tailscale endpoint provider", () => {
  it.effect("does not advertise Proton's CGNAT address as a Tailscale pairing endpoint", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        networkInterfaces: protonAndTailscaleInterfaces,
        statusJson: `{"Self":{"TailscaleIPs":["100.74.126.34"]}}`,
      });
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.httpBaseUrl),
        ["http://100.74.126.34:3773/"],
      );
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect("keeps native Tailscale interfaces with missing, malformed, or stale status", () =>
    Effect.gen(function* () {
      for (const interfaceName of ["tailscale0", "Tailscale"]) {
        for (const statusJson of [null, "not-json", `{"Self":{"TailscaleIPs":[]}}`]) {
          const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
            port: 3773,
            networkInterfaces: {
              pvpnksintrf1: protonAndTailscaleInterfaces.pvpnksintrf1,
              [interfaceName]: protonAndTailscaleInterfaces.tailscale0,
            },
            statusJson,
          });
          assert.deepEqual(
            endpoints.map((endpoint) => endpoint.httpBaseUrl),
            ["http://100.74.126.34:3773/"],
          );
        }
      }
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect(
    "recognizes a macOS Tailscale tunnel by its IPv6 address when status is unavailable",
    () =>
      Effect.gen(function* () {
        const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
          port: 3773,
          networkInterfaces: {
            utun3: [{ address: "100.85.0.1", family: "IPv4", internal: false }],
            utun4: [
              { address: "100.74.126.34", family: "IPv4", internal: false },
              { address: "fd7a:115c:a1e0::1234", family: "IPv6", internal: false },
            ],
          },
          statusJson: null,
        });
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://100.74.126.34:3773/"],
        );
      }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect("parses MagicDNS names from tailscale status", () =>
    Effect.gen(function* () {
      const dnsName = yield* parseTailscaleMagicDnsName(
        `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
      );
      assert.equal(dnsName, "desktop.tail.ts.net");
      assert.equal(yield* parseTailscaleMagicDnsName("{}"), null);
      const malformed = yield* Effect.result(parseTailscaleMagicDnsName("not-json"));
      assert.isTrue(malformed._tag === "Failure");
    }),
  );

  it.effect(
    "marks the Tailscale HTTPS endpoint available after Serve is enabled and reachable",
    () =>
      Effect.gen(function* () {
        const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
          port: 3773,
          networkInterfaces: {},
          statusJson: `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
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
      }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );
});
