import { describe, expect, it } from "vite-plus/test";

import {
  isProjectFaviconFallbackUrl,
  PROJECT_FAVICON_FALLBACK_MARKER,
  withProjectFaviconReloadParam,
} from "./projectFavicon.ts";

describe("project favicon", () => {
  it("identifies fallback asset URLs by their dedicated filename", () => {
    expect(
      isProjectFaviconFallbackUrl(
        `https://environment.example/api/assets/signed-token/${PROJECT_FAVICON_FALLBACK_MARKER}`,
      ),
    ).toBe(true);
    expect(
      isProjectFaviconFallbackUrl(`/api/assets/signed-token/${PROJECT_FAVICON_FALLBACK_MARKER}`),
    ).toBe(true);
  });

  it("does not mistake real favicons or query parameters for fallbacks", () => {
    expect(
      isProjectFaviconFallbackUrl("https://environment.example/api/assets/token/favicon.svg"),
    ).toBe(false);
    expect(
      isProjectFaviconFallbackUrl(
        `https://environment.example/api/assets/token/favicon.svg?name=${PROJECT_FAVICON_FALLBACK_MARKER}`,
      ),
    ).toBe(false);
    expect(isProjectFaviconFallbackUrl(null)).toBe(false);
  });
});

describe("withProjectFaviconReloadParam", () => {
  it("leaves the URL untouched until a reload is requested", () => {
    expect(withProjectFaviconReloadParam("/api/assets/token/favicon.svg", 0)).toBe(
      "/api/assets/token/favicon.svg",
    );
    expect(withProjectFaviconReloadParam("/api/assets/token/favicon.svg", -1)).toBe(
      "/api/assets/token/favicon.svg",
    );
  });

  it("appends a cache-busting parameter with the right separator", () => {
    expect(withProjectFaviconReloadParam("/api/assets/token/favicon.svg", 2)).toBe(
      "/api/assets/token/favicon.svg?faviconReload=2",
    );
    expect(withProjectFaviconReloadParam("/api/assets/token/favicon.svg?name=x", 3)).toBe(
      "/api/assets/token/favicon.svg?name=x&faviconReload=3",
    );
  });
});
