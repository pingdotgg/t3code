import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { isLoopbackHostname, resolveAssetCacheControl, resolveDevRedirectUrl } from "./http.ts";

describe("asset response caching", () => {
  it("does not cache attachment downloads", () => {
    expect(resolveAssetCacheControl("attachment")).toBe("private, no-store");
  });

  it("keeps preview assets cacheable", () => {
    expect(resolveAssetCacheControl(undefined)).toBe("private, max-age=3600");
  });
});

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
