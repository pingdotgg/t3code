import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
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

/** The local backend reports `this-desktop`; the tailnet URL reports `servedEnvironmentId`. */
const layerServeAnswers = (servedEnvironmentId: string) =>
  Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const environmentId = request.url.startsWith("http://127.0.0.1:3773/")
          ? "this-desktop"
          : servedEnvironmentId;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ environmentId }))),
        );
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unexpected tailscale status process")),
    ),
  );

const resolveServeEndpointStatus = (servedEnvironmentId: string) =>
  resolveTailscaleAdvertisedEndpoints({
    port: 3773,
    serveEnabled: true,
    localHttpUrl: "http://127.0.0.1:3773",
    networkInterfaces: {},
    statusJson: `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":[]}}`,
  }).pipe(
    Effect.map((endpoints) => endpoints.map((endpoint) => [endpoint.httpBaseUrl, endpoint.status])),
    Effect.provide(layerServeAnswers(servedEnvironmentId)),
  );

describe("tailscale endpoint provider", () => {
  it.effect("lists Tailscale HTTPS as available only while it reaches this desktop's server", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* resolveServeEndpointStatus("this-desktop"), [
        ["https://desktop.tail.ts.net/", "available"],
      ]);
      assert.deepEqual(yield* resolveServeEndpointStatus("other-desktop"), [
        ["https://desktop.tail.ts.net/", "unavailable"],
      ]);
    }),
  );

  it.effect("does not advertise Proton's CGNAT address as a Tailscale pairing endpoint", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        localHttpUrl: "http://127.0.0.1:3773",
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
            localHttpUrl: "http://127.0.0.1:3773",
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
          localHttpUrl: "http://127.0.0.1:3773",
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
