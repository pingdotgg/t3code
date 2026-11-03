import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

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
});

it.effect("advertises direct MagicDNS only for a running Self on the listener interface", () =>
  Effect.gen(function* () {
    for (const serveEnabled of [false, true]) {
      for (const [bindHost, backendState, ip, expected] of [
        ["0.0.0.0", "Running", "100.74.126.34", true],
        ["100.74.126.34", "Running", "100.74.126.34", true],
        ["127.0.0.1", "Running", "100.74.126.34", false],
        ["192.168.1.2", "Running", "100.74.126.34", false],
        ["0.0.0.0", "Stopped", "100.74.126.34", false],
        ["0.0.0.0", "Unknown", "100.74.126.34", false],
        ["::1", "Running", "100.74.126.34", false],
        ["0.0.0.0", "Running", "100.85.0.1", false],
      ] as const) {
        const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
          port: 3773,
          bindHost,
          serveEnabled,
          probe: () => Effect.succeed(true),
          networkInterfaces: { tailscale0: protonAndTailscaleInterfaces.tailscale0 },
          statusJson: JSON.stringify({
            BackendState: backendState,
            Self: { DNSName: "desktop.tail.ts.net.", TailscaleIPs: [ip] },
          }),
        });
        assert.strictEqual(
          endpoints.some((e) => e.httpBaseUrl === "http://desktop.tail.ts.net:3773/"),
          expected,
        );
        if (expected && serveEnabled) {
          const urls = endpoints.map((endpoint) => endpoint.httpBaseUrl);
          assert.isBelow(
            urls.indexOf("https://desktop.tail.ts.net/"),
            urls.indexOf("http://desktop.tail.ts.net:3773/"),
          );
        }
      }
    }
    for (const statusJson of [
      null,
      "not-json",
      "{}",
      JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "evil.example/path", TailscaleIPs: ["100.74.126.34"] },
      }),
    ]) {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        bindHost: "0.0.0.0",
        networkInterfaces: protonAndTailscaleInterfaces,
        statusJson,
      });
      assert.isFalse(endpoints.some((endpoint) => endpoint.label === "Tailscale MagicDNS"));
    }
  }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
);
