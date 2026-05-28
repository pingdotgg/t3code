import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdvertisedEndpoint } from "@t3tools/contracts";

import { MobileAccessSection } from "./MobileAccessSection";

vi.mock("~/environments/primary", () => ({
  createServerPairingCredential: vi.fn().mockResolvedValue({
    credential: "test-credential-abc",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }),
}));

function makeTailscaleEndpoint(
  status: AdvertisedEndpoint["status"] = "available",
): AdvertisedEndpoint {
  return {
    id: "tailscale-magicdns:mintrose.tail98085b.ts.net",
    label: "Tailscale HTTPS",
    provider: { id: "tailscale", label: "Tailscale", kind: "tunnel", isAddon: false },
    httpBaseUrl: "https://mintrose.tail98085b.ts.net",
    wsBaseUrl: "wss://mintrose.tail98085b.ts.net",
    reachability: "private-network",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "desktop-core",
    status,
  };
}

describe("MobileAccessSection", () => {
  it("disables the toggle and shows install hint when no Tailscale endpoint is present", () => {
    const markup = renderToStaticMarkup(
      <MobileAccessSection
        endpoints={[]}
        isTailscaleServeEnabled={false}
        isUpdating={false}
        onEnable={() => {}}
        onDisable={() => {}}
      />,
    );

    expect(markup).toContain("Install Tailscale on this machine");
    expect(markup).not.toContain("mobile-access-qr-frame");
  });

  it("shows the connect description when a Tailscale endpoint is present but Serve is off", () => {
    const markup = renderToStaticMarkup(
      <MobileAccessSection
        endpoints={[makeTailscaleEndpoint("unavailable")]}
        isTailscaleServeEnabled={false}
        isUpdating={false}
        onEnable={() => {}}
        onDisable={() => {}}
      />,
    );

    expect(markup).toContain("install T3 Code on your phone");
    expect(markup).not.toContain("mobile-access-qr-frame");
  });

  it("renders the reachable panel when Tailscale Serve is enabled and endpoint is available", () => {
    // useEffect does not fire during renderToStaticMarkup, so we verify the
    // outer reachable panel mounts; inner QR / spinner depend on async state.
    const markup = renderToStaticMarkup(
      <MobileAccessSection
        endpoints={[makeTailscaleEndpoint("available")]}
        isTailscaleServeEnabled={true}
        isUpdating={false}
        onEnable={() => {}}
        onDisable={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="mobile-access-reachable-panel"');
  });

  it("does not render the reachable panel when Tailscale Serve is disabled", () => {
    const markup = renderToStaticMarkup(
      <MobileAccessSection
        endpoints={[makeTailscaleEndpoint("available")]}
        isTailscaleServeEnabled={false}
        isUpdating={false}
        onEnable={() => {}}
        onDisable={() => {}}
      />,
    );

    expect(markup).not.toContain('data-testid="mobile-access-reachable-panel"');
  });
});
