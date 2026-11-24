import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  endpointShareHint,
  resolveAdvertisedEndpointPairingUrl,
} from "./ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "./pairingUrls";

const tailnetEndpoint = {
  id: "tailscale-magicdns:host",
  label: "Tailscale",
  provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: false },
  httpBaseUrl: "https://host.tailnet.example.ts.net:3773",
  wsBaseUrl: "wss://host.tailnet.example.ts.net:3773",
  reachability: "private-network",
  compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
  source: "desktop-core",
  status: "available",
} satisfies AdvertisedEndpoint;

describe("settings pairing URL helpers", () => {
  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("pairs an HTTPS endpoint on its own origin", () => {
    expect(resolveAdvertisedEndpointPairingUrl(tailnetEndpoint, "PAIRCODE")).toBe(
      "https://host.tailnet.example.ts.net:3773/pair#token=PAIRCODE",
    );
    expect(endpointShareHint(tailnetEndpoint)).toBe("Devices on your private network");
  });
});
