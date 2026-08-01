import { describe, expect, it } from "vite-plus/test";

import { mobilePreviewAnnotationUrl } from "./mobilePreviewSourceUrl";

describe("mobile preview annotation URL", () => {
  it("preserves direct WebView navigation URLs", () => {
    expect(
      mobilePreviewAnnotationUrl({
        documentUrl: "http://192.168.1.20:5173/settings?tab=team#billing",
        sourceUrl: "http://localhost:5173/",
        isolatedGateway: false,
      }),
    ).toBe("http://192.168.1.20:5173/settings?tab=team#billing");
  });

  it("maps an isolated Connect document back to the original preview origin", () => {
    expect(
      mobilePreviewAnnotationUrl({
        documentUrl: "https://environment.t3.codes/settings?tab=team#billing",
        gatewayUrl:
          "https://environment.t3.codes/api/preview-gateway/bootstrap/secret-bootstrap-token",
        sourceUrl: "http://localhost:5173/checkout",
        isolatedGateway: true,
      }),
    ).toBe("http://localhost:5173/settings?tab=team#billing");
  });

  it("retains external navigation URLs instead of mapping them to localhost", () => {
    expect(
      mobilePreviewAnnotationUrl({
        documentUrl: "https://docs.example.com/guide?from=preview",
        gatewayUrl:
          "https://environment.t3.codes/api/preview-gateway/bootstrap/secret-bootstrap-token",
        sourceUrl: "http://localhost:5173/checkout",
        isolatedGateway: true,
      }),
    ).toBe("https://docs.example.com/guide?from=preview");
  });

  it("does not expose a one-time gateway bootstrap path as preview context", () => {
    expect(
      mobilePreviewAnnotationUrl({
        documentUrl:
          "https://environment.t3.codes/api/preview-gateway/bootstrap/secret-bootstrap-token",
        gatewayUrl:
          "https://environment.t3.codes/api/preview-gateway/bootstrap/secret-bootstrap-token",
        sourceUrl: "http://localhost:5173/checkout",
        isolatedGateway: true,
      }),
    ).toBe("http://localhost:5173/checkout");
  });

  it("never leaks a malformed gateway URL into annotation context", () => {
    expect(
      mobilePreviewAnnotationUrl({
        documentUrl: "not a url",
        gatewayUrl:
          "https://environment.t3.codes/api/preview-gateway/bootstrap/secret-bootstrap-token",
        sourceUrl: "http://localhost:5173/checkout",
        isolatedGateway: true,
      }),
    ).toBe("http://localhost:5173/checkout");
  });
});
