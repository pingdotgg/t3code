import { describe, expect, it } from "vite-plus/test";

import { resolveMobilePreviewLiveTarget } from "./previewLiveTarget";

describe("resolveMobilePreviewLiveTarget", () => {
  it("keeps public preview URLs direct", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "https://example.com/checkout?step=2#payment",
        environmentHttpBaseUrl: "https://connect.t3.codes",
      }),
    ).toEqual({
      kind: "available",
      uri: "https://example.com/checkout?step=2#payment",
      resolution: "direct",
    });
  });

  it("maps desktop localhost onto a LAN environment host", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://localhost:5173/dashboard?mode=test#results",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
      }),
    ).toEqual({
      kind: "available",
      uri: "http://192.168.1.25:5173/dashboard?mode=test#results",
      resolution: "environment-private-network",
    });
  });

  it("treats a DNS-root-qualified localhost as desktop loopback", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://localhost.:5173/dashboard",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
      }),
    ).toEqual({
      kind: "available",
      uri: "http://192.168.1.25:5173/dashboard",
      resolution: "environment-private-network",
    });
  });

  it("maps desktop localhost onto a Tailscale host", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "localhost:3000/app",
        environmentHttpBaseUrl: "https://devbox.tailnet-name.ts.net",
      }),
    ).toEqual({
      kind: "available",
      uri: "http://devbox.tailnet-name.ts.net:3000/app",
      resolution: "environment-private-network",
    });
  });

  it("routes iPad LAN loopback previews through the authenticated gateway", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://localhost:5173/dashboard",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
        platform: "ios",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "gateway-required" });
  });

  it("routes iPad Tailscale loopback previews through the authenticated gateway", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://localhost:3000/app",
        environmentHttpBaseUrl: "https://devbox.tailnet-name.ts.net",
        platform: "ios",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "gateway-required" });
  });

  it("maps desktop localhost onto a single-label MagicDNS host", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://127.0.0.1:4173/app",
        environmentHttpBaseUrl: "http://devbox:3773",
      }),
    ).toEqual({
      kind: "available",
      uri: "http://devbox:4173/app",
      resolution: "environment-private-network",
    });
  });

  it("maps every IPv4 loopback address onto the environment host", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://127.0.0.42:4173/app",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
      }),
    ).toEqual({
      kind: "available",
      uri: "http://192.168.1.25:4173/app",
      resolution: "environment-private-network",
    });
  });

  it("does not send localhost subdomains to the iPad loopback interface", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "http://app.localhost:4173",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "local-loopback" });
  });

  it("does not treat the iPad's loopback as the desktop", () => {
    const target = resolveMobilePreviewLiveTarget({
      previewUrl: "http://localhost:5173",
      environmentHttpBaseUrl: "http://127.0.0.1:3773",
    });
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") {
      expect(target.reason).toBe("local-loopback");
    }
  });

  it("routes Connect-hosted environment ports through the live gateway", () => {
    const target = resolveMobilePreviewLiveTarget({
      previewUrl: "http://localhost:5173",
      environmentHttpBaseUrl: "https://relay.example.com",
      platform: "ios",
    });
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") {
      expect(target.reason).toBe("gateway-required");
      expect(target.detail).toMatch(/authenticated preview gateway/);
    }
  });

  it("keeps Connect gateway previews snapshot-only on Android", () => {
    const target = resolveMobilePreviewLiveTarget({
      previewUrl: "http://localhost:5173",
      environmentHttpBaseUrl: "https://relay.example.com",
      platform: "android",
    });
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") {
      expect(target.reason).toBe("gateway-required");
      expect(target.detail).toMatch(/available on iPad only/);
      expect(target.detail).toMatch(/snapshot review/);
    }
  });

  it("keeps relay-managed private-looking endpoints snapshot-only", () => {
    const target = resolveMobilePreviewLiveTarget({
      previewUrl: "http://localhost:5173",
      environmentHttpBaseUrl: "http://100.100.10.20:3773",
      environmentRelayManaged: true,
    });
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") {
      expect(target.reason).toBe("gateway-required");
    }
  });

  it("rejects non-web preview URLs", () => {
    expect(
      resolveMobilePreviewLiveTarget({
        previewUrl: "file:///tmp/index.html",
        environmentHttpBaseUrl: "http://192.168.1.25:3773",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "invalid-url" });
  });
});
