import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isShareableOrigin,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats only reachable web origins as shareable", () => {
    expect(isShareableOrigin({ protocol: "https:", hostname: "app.example.com" })).toBe(true);
    expect(isShareableOrigin({ protocol: "http:", hostname: "192.168.1.44" })).toBe(true);

    // The packaged desktop app loads from `t3code-dev://app/`. Its hostname is
    // not a loopback name, so a loopback-only check would call this shareable
    // and offer copy/QR for a URL no other device can open.
    expect(isShareableOrigin({ protocol: "t3code-dev:", hostname: "app" })).toBe(false);
    expect(isShareableOrigin({ protocol: "file:", hostname: "" })).toBe(false);

    expect(isShareableOrigin({ protocol: "http:", hostname: "localhost" })).toBe(false);
    expect(isShareableOrigin({ protocol: "http:", hostname: "127.0.0.1" })).toBe(false);
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
