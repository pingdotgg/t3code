import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  resolveTailscaleAdvertisedEndpoints,
} from "./tailscaleEndpointProvider.ts";

describe("tailscale endpoint provider", () => {
  it("detects Tailnet IPv4 addresses", () => {
    expect(isTailscaleIpv4Address("100.64.0.1")).toBe(true);
    expect(isTailscaleIpv4Address("100.127.255.254")).toBe(true);
    expect(isTailscaleIpv4Address("100.128.0.1")).toBe(false);
    expect(isTailscaleIpv4Address("192.168.1.44")).toBe(false);
  });

  it("parses MagicDNS names from tailscale status", async () => {
    expect(
      Effect.runSync(
        parseTailscaleMagicDnsName(JSON.stringify({ Self: { DNSName: "desktop.tail.ts.net." } })),
      ),
    ).toBe("desktop.tail.ts.net");
    expect(Effect.runSync(parseTailscaleMagicDnsName("{}"))).toBeNull();
    await expect(Effect.runPromise(parseTailscaleMagicDnsName("not-json"))).rejects.toBeDefined();
  });

  it("resolves Tailscale endpoints as add-on advertised endpoints", async () => {
    await expect(
      resolveTailscaleAdvertisedEndpoints({
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
        statusJson: JSON.stringify({ Self: { DNSName: "desktop.tail.ts.net." } }),
      }),
    ).resolves.toEqual([
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
  });

  it("marks the Tailscale HTTPS endpoint available after Serve is enabled and reachable", async () => {
    await expect(
      resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        networkInterfaces: {},
        statusJson: JSON.stringify({ Self: { DNSName: "desktop.tail.ts.net." } }),
        serveEnabled: true,
        probe: async () => true,
      }),
    ).resolves.toEqual([
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
  });
});
