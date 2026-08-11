import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  assetResponseHeaders,
  isLoopbackHostname,
  pluginAssetResponseHeaders,
  resolveDevRedirectUrl,
} from "./http.ts";

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
});

describe("pluginAssetResponseHeaders", () => {
  it("pins script and style sources to the asset origin so the sandboxed frame can run", () => {
    // The plugin iframe is sandboxed without allow-same-origin, so its document has
    // an opaque origin and 'self' would match nothing — blocking the plugin's own
    // bundle. Regression guard: the concrete origin must be used instead.
    const csp =
      pluginAssetResponseHeaders(["http://localhost:5733"], ["'self'"])[
        "Content-Security-Policy"
      ] ?? "";
    expect(csp).toContain("script-src http://localhost:5733");
    expect(csp).toContain("style-src http://localhost:5733 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self'");
    expect(csp).not.toContain("style-src 'self'");
  });

  it("keeps CORP cross-origin so the opaque-origin plugin frame can load its assets", () => {
    // The plugin iframe is sandboxed without allow-same-origin, so it fetches from a
    // null origin. "same-origin" here makes the browser discard every subresource and
    // the plugin renders blank. Verified live before this guard was added.
    const headers = pluginAssetResponseHeaders(["http://localhost:5733"], ["'self'"]);
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
  });

  it("blocks network access and credential-bearing referrers", () => {
    const headers = pluginAssetResponseHeaders(
      ["http://localhost:5733"],
      ["'self'", "t3code://app"],
    );
    expect(headers).toMatchObject({
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    expect(headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'none'");
  });

  it("scopes frame-ancestors to the trusted embedder origins, not a scheme wildcard", () => {
    const headers = pluginAssetResponseHeaders(
      ["http://localhost:5733"],
      ["'self'", "t3code://app", "t3code-dev://app"],
    );
    const csp = headers["Content-Security-Policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'self' t3code://app t3code-dev://app");
    const frameAncestors = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("frame-ancestors"));
    expect(frameAncestors).toBeDefined();
    expect(frameAncestors).not.toContain(" http:");
    expect(frameAncestors).not.toContain(" https:");
  });
});
