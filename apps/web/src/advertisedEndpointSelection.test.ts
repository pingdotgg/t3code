import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { endpointDefaultPreferenceKey, selectPairingEndpoint } from "./advertisedEndpointSelection";

function endpoint(input: {
  readonly id: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpoint["reachability"];
  readonly status?: AdvertisedEndpoint["status"];
  readonly isDefault?: boolean;
}): AdvertisedEndpoint {
  const url = new URL(input.httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  const wsUrl = new URL(url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    id: input.id,
    label: input.label,
    provider: {
      id: input.id.split(":")[0] ?? "test",
      label: "Test",
      kind: "core",
      isAddon: false,
    },
    httpBaseUrl: url.toString(),
    wsBaseUrl: wsUrl.toString(),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp: url.protocol === "https:" ? "compatible" : "mixed-content-blocked",
      desktopApp: "compatible",
    },
    source: "desktop-core",
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  };
}

describe("endpointDefaultPreferenceKey", () => {
  it("uses stable keys for desktop and tailscale endpoints", () => {
    expect(
      endpointDefaultPreferenceKey(
        endpoint({
          id: "tailscale-ip:100.105.249.96",
          label: "Tailscale IP",
          httpBaseUrl: "http://100.105.249.96:3773/",
          reachability: "private-network",
        }),
      ),
    ).toBe("tailscale:ip:http");
  });
});

describe("selectPairingEndpoint", () => {
  it("uses the saved default endpoint over the built-in default", () => {
    const loopback = endpoint({
      id: "desktop-loopback:127.0.0.1",
      label: "This machine",
      httpBaseUrl: "http://127.0.0.1:3773/",
      reachability: "loopback",
      isDefault: true,
    });
    const tailscale = endpoint({
      id: "tailscale-ip:100.105.249.96",
      label: "Tailscale IP",
      httpBaseUrl: "http://100.105.249.96:3773/",
      reachability: "private-network",
    });

    expect(selectPairingEndpoint([loopback, tailscale], "tailscale:ip:http")).toBe(tailscale);
  });

  it("prefers enabled Tailscale HTTPS when the saved default is Tailscale IP", () => {
    const tailscale = endpoint({
      id: "tailscale-ip:100.105.249.96",
      label: "Tailscale IP",
      httpBaseUrl: "http://100.105.249.96:3773/",
      reachability: "private-network",
    });
    const tailscaleHttps = endpoint({
      id: "tailscale-magicdns:https://desktop.tail.ts.net/",
      label: "Tailscale HTTPS",
      httpBaseUrl: "https://desktop.tail.ts.net/",
      reachability: "private-network",
    });

    expect(selectPairingEndpoint([tailscale, tailscaleHttps], "tailscale:ip:http")).toBe(
      tailscaleHttps,
    );
  });

  it("keeps Tailscale IP when Tailscale HTTPS is not enabled", () => {
    const tailscale = endpoint({
      id: "tailscale-ip:100.105.249.96",
      label: "Tailscale IP",
      httpBaseUrl: "http://100.105.249.96:3773/",
      reachability: "private-network",
    });
    const tailscaleHttps = endpoint({
      id: "tailscale-magicdns:https://desktop.tail.ts.net/",
      label: "Tailscale HTTPS",
      httpBaseUrl: "https://desktop.tail.ts.net/",
      reachability: "private-network",
      status: "unavailable",
    });

    expect(selectPairingEndpoint([tailscale, tailscaleHttps], "tailscale:ip:http")).toBe(tailscale);
  });

  it("ignores unavailable saved endpoints", () => {
    const unavailableTailscale = endpoint({
      id: "tailscale-ip:100.105.249.96",
      label: "Tailscale IP",
      httpBaseUrl: "http://100.105.249.96:3773/",
      reachability: "private-network",
      status: "unavailable",
    });
    const lan = endpoint({
      id: "desktop-lan:192.168.178.55",
      label: "Local network",
      httpBaseUrl: "http://192.168.178.55:3773/",
      reachability: "lan",
    });

    expect(selectPairingEndpoint([unavailableTailscale, lan], "tailscale:ip:http")).toBe(lan);
  });
});
