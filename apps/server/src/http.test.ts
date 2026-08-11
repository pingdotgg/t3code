import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { assetResponseHeaders, isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("marks non-image assets as downloads with their requested filename", () => {
    expect(assetResponseHeaders("/attachments/id.bin", true, "vendor-report.csv")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition":
        "attachment; filename=\"vendor-report.csv\"; filename*=UTF-8''vendor-report.csv",
    });
  });

  it("encodes Unicode download names without putting non-Latin-1 bytes in the header", () => {
    const contentDisposition = assetResponseHeaders("/attachments/id.bin", true, "报告 📄.pdf")[
      "Content-Disposition"
    ];

    expect(contentDisposition).toBe(
      "attachment; filename=\"__ _.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%F0%9F%93%84.pdf",
    );
    // eslint-disable-next-line no-control-regex
    expect(contentDisposition).not.toMatch(/[^\x00-\x7f]/u);
  });
});
