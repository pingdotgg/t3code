import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  resolveTailscaleAdvertisedEndpoints,
} from "./tailscaleEndpointProvider.ts";

const unusedTailscaleExternalServicesLayer = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected tailscale status process")),
  ),
);

describe("tailscale endpoint provider", () => {
  it("detects Tailnet IPv4 addresses", () => {
    assert.equal(isTailscaleIpv4Address("100.64.0.1"), true);
    assert.equal(isTailscaleIpv4Address("100.127.255.254"), true);
    assert.equal(isTailscaleIpv4Address("100.128.0.1"), false);
    assert.equal(isTailscaleIpv4Address("192.168.1.44"), false);
  });

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

  it.effect("resolves Tailscale endpoints as add-on advertised endpoints", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
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
        statusJson: `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
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
      ]);
    }).pipe(Effect.provide(unusedTailscaleExternalServicesLayer)),
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
      }).pipe(Effect.provide(unusedTailscaleExternalServicesLayer)),
  );
});
