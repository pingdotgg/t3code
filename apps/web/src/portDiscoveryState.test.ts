import { CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS, PREVIEW_URL_MAX_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundConfiguredLocalServerUrls, isPathWithin } from "./portDiscoveryState";

describe("isPathWithin", () => {
  it("matches the root and its descendants but not a sibling sharing its prefix", () => {
    expect(isPathWithin("/a/foo", "/a/foo")).toBe(true);
    expect(isPathWithin("/a/foo/apps/api", "/a/foo/")).toBe(true);
    expect(isPathWithin("C:\\a\\foo\\api", "C:\\a\\foo")).toBe(true);
    expect(isPathWithin("/a/foobar", "/a/foo")).toBe(false);
    expect(isPathWithin("/a", "/a/foo")).toBe(false);
  });
});

describe("boundConfiguredLocalServerUrls", () => {
  it("keeps subscription payloads within the discovery RPC bounds", () => {
    const urls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
      (_, index) => `http://localhost:${3_000 + index}`,
    );
    urls.unshift(
      "https://example.com",
      "not a URL",
      `http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`,
    );

    const bounded = boundConfiguredLocalServerUrls(urls);

    expect(bounded).toHaveLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS);
    expect(bounded.every((url) => url.startsWith("http://localhost:"))).toBe(true);
  });

  it("does not let fragment-only variants crowd out another server", () => {
    const fragments = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:3000/docs#section-${index}`,
    );

    expect(boundConfiguredLocalServerUrls([...fragments, "http://localhost:4000/app"])).toEqual([
      "http://localhost:3000/docs#section-0",
      "http://localhost:4000/app",
    ]);
  });
});
