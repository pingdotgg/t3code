import { describe, expect, it } from "vite-plus/test";

import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
  PROJECT_FAVICON_FALLBACK_MARKER,
} from "./projectFavicon.ts";

describe("project favicon", () => {
  it("uses the project and versioned filename as the cache identity", () => {
    const firstUrl = "https://environment.example/api/assets/first-signed-token/v1-20-favicon.svg";
    const refreshedUrl =
      "https://environment.example/api/assets/refreshed-signed-token/v1-20-favicon.svg";

    expect(getProjectFaviconCacheKey("environment-1", "/workspace", firstUrl)).toBe(
      getProjectFaviconCacheKey("environment-1", "/workspace", refreshedUrl),
    );
    expect(getProjectFaviconCacheKey("environment-1", "/workspace", firstUrl)).not.toBe(
      getProjectFaviconCacheKey(
        "environment-1",
        "/workspace",
        "https://environment.example/api/assets/refreshed-signed-token/v2-20-favicon.svg",
      ),
    );
    expect(getProjectFaviconCacheKey("environment-1", "/workspace", firstUrl)).not.toBe(
      getProjectFaviconCacheKey("environment-2", "/workspace", firstUrl),
    );
  });

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
