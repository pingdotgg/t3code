import { describe, expect, it } from "vite-plus/test";

import {
  mobilePreviewGatewayRequestKey,
  mobilePreviewGatewayTargetMatches,
  resolveMobilePreviewGatewayUri,
  type MobilePreviewGatewayTarget,
} from "./mobilePreviewGatewayModel";

const target: MobilePreviewGatewayTarget = {
  environmentHttpBaseUrl: "https://environment.t3.codes",
  expiresAt: 1_000,
  serverEpoch: "server-1",
  sourceUrl: "http://localhost:5173/checkout",
  tabId: "tab-1",
  uri: "https://environment.t3.codes/api/preview-gateway/bootstrap/ticket",
};

describe("mobile preview gateway model", () => {
  it("keys one in-flight request to the exact server, tab, and preview URL", () => {
    const key = mobilePreviewGatewayRequestKey({
      serverEpoch: "server-1",
      sourceUrl: "http://localhost:5173/checkout",
      tabId: "tab-1",
    });
    expect(key).toBe(
      mobilePreviewGatewayRequestKey({
        serverEpoch: "server-1",
        sourceUrl: "http://localhost:5173/checkout",
        tabId: "tab-1",
      }),
    );
    expect(key).not.toBe(
      mobilePreviewGatewayRequestKey({
        serverEpoch: "server-1",
        sourceUrl: "http://localhost:4173/checkout",
        tabId: "tab-1",
      }),
    );
  });

  it("resolves a same-origin bootstrap path", () => {
    expect(
      resolveMobilePreviewGatewayUri({
        environmentHttpBaseUrl: "https://environment.t3.codes/some/base",
        relativeUrl: "/api/preview-gateway/bootstrap/ticket",
      }),
    ).toBe("https://environment.t3.codes/api/preview-gateway/bootstrap/ticket");
  });

  it("rejects cross-origin and non-http bootstrap addresses", () => {
    for (const relativeUrl of [
      "//attacker.example/bootstrap",
      "https://attacker.example/bootstrap",
      "api/preview-gateway/bootstrap/ticket",
      "/api/not-the-preview-gateway/ticket",
      "/api/preview-gateway/bootstrap/../other",
    ]) {
      expect(() =>
        resolveMobilePreviewGatewayUri({
          environmentHttpBaseUrl: "https://environment.t3.codes",
          relativeUrl,
        }),
      ).toThrow("invalid bootstrap address");
    }
    expect(() =>
      resolveMobilePreviewGatewayUri({
        environmentHttpBaseUrl: "file:///tmp/environment",
        relativeUrl: "/api/preview-gateway/bootstrap/ticket",
      }),
    ).toThrow("invalid bootstrap address");
  });

  it("matches a lease only to its tab, server epoch, and exact preview URL", () => {
    expect(
      mobilePreviewGatewayTargetMatches({
        target,
        environmentHttpBaseUrl: target.environmentHttpBaseUrl,
        serverEpoch: "server-1",
        sourceUrl: "http://localhost:5173/checkout",
        tabId: "tab-1",
      }),
    ).toBe(true);
    expect(
      mobilePreviewGatewayTargetMatches({
        target,
        environmentHttpBaseUrl: target.environmentHttpBaseUrl,
        serverEpoch: "server-1",
        sourceUrl: "http://localhost:4173/checkout",
        tabId: "tab-1",
      }),
    ).toBe(false);
    expect(
      mobilePreviewGatewayTargetMatches({
        target,
        environmentHttpBaseUrl: target.environmentHttpBaseUrl,
        serverEpoch: "server-2",
        sourceUrl: target.sourceUrl,
        tabId: target.tabId,
      }),
    ).toBe(false);
    expect(
      mobilePreviewGatewayTargetMatches({
        target,
        environmentHttpBaseUrl: "https://new-environment.t3.codes",
        serverEpoch: target.serverEpoch,
        sourceUrl: target.sourceUrl,
        tabId: target.tabId,
      }),
    ).toBe(false);
  });
});
