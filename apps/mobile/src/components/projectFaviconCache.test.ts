import { describe, expect, it } from "vite-plus/test";

import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
} from "./projectFaviconCache";

describe("project favicon cache", () => {
  it("ignores callbacks from a superseded URL", () => {
    const cacheKey = "environment-1:/workspace:v1-favicon.svg";
    const expiredUrl = "https://environment.example/api/assets/expired/v1-favicon.svg";
    const refreshedUrl = "https://environment.example/api/assets/refreshed/v1-favicon.svg";

    const expiredRequest = createProjectFaviconRequest(cacheKey, expiredUrl);
    const endExpiredRequest = beginProjectFaviconRequest(expiredRequest);
    markProjectFaviconLoaded(expiredRequest);
    const refreshedRequest = createProjectFaviconRequest(cacheKey, refreshedUrl);
    const endRefreshedRequest = beginProjectFaviconRequest(refreshedRequest);

    expect(markProjectFaviconLoaded(expiredRequest)).toBe(false);
    expect(markProjectFaviconFailed(expiredRequest)).toBe(false);
    expect(hasLoadedProjectFavicon(cacheKey)).toBe(true);
    expect(markProjectFaviconFailed(refreshedRequest)).toBe(true);
    expect(hasLoadedProjectFavicon(cacheKey)).toBe(false);

    endRefreshedRequest();
    endExpiredRequest();
  });

  it("evicts the URL that actually failed", () => {
    const cacheKey = "environment-1:/workspace:v2-favicon.svg";
    const faviconUrl = "https://environment.example/api/assets/current/v2-favicon.svg";
    const request = createProjectFaviconRequest(cacheKey, faviconUrl);
    const endRequest = beginProjectFaviconRequest(request);

    markProjectFaviconLoaded(request);

    expect(markProjectFaviconFailed(request)).toBe(true);
    expect(hasLoadedProjectFavicon(cacheKey)).toBe(false);

    endRequest();
  });

  it("does not supersede a request until the next request begins", () => {
    const cacheKey = "environment-1:/workspace:v3-favicon.svg";
    const committedUrl = "https://environment.example/api/assets/current/v3-favicon.svg";
    const abandonedUrl = "https://environment.example/api/assets/abandoned/v3-favicon.svg";
    const committedRequest = createProjectFaviconRequest(cacheKey, committedUrl);
    const endCommittedRequest = beginProjectFaviconRequest(committedRequest);

    createProjectFaviconRequest(cacheKey, abandonedUrl);

    expect(markProjectFaviconLoaded(committedRequest)).toBe(true);
    expect(hasLoadedProjectFavicon(cacheKey)).toBe(true);

    endCommittedRequest();
  });

  it("requires a cache key before creating a URL-bearing request", () => {
    const firstUrl = "https://environment.example/api/assets/first/favicon.svg";
    const secondUrl = "https://environment.example/api/assets/second/favicon.svg";

    expect(createProjectFaviconRequest(null, firstUrl)).toBeNull();
    expect(createProjectFaviconRequest(null, secondUrl)).toBeNull();
  });

  it("restores the remaining active URL when a newer request ends", () => {
    const cacheKey = "environment-1:/workspace:v4-favicon.svg";
    const firstRequest = createProjectFaviconRequest(
      cacheKey,
      "https://environment.example/api/assets/first/v4-favicon.svg",
    );
    const secondRequest = createProjectFaviconRequest(
      cacheKey,
      "https://environment.example/api/assets/second/v4-favicon.svg",
    );
    const endFirstRequest = beginProjectFaviconRequest(firstRequest);
    const endSecondRequest = beginProjectFaviconRequest(secondRequest);

    expect(markProjectFaviconLoaded(firstRequest)).toBe(false);
    endSecondRequest();
    expect(markProjectFaviconLoaded(firstRequest)).toBe(true);
    endFirstRequest();
    expect(markProjectFaviconLoaded(firstRequest)).toBe(false);
  });

  it("bounds remembered loaded revisions", () => {
    const firstCacheKey = "environment-1:/workspace:revision-0";
    let lastCacheKey = firstCacheKey;

    for (let revision = 0; revision < 300; revision++) {
      lastCacheKey = `environment-1:/workspace:revision-${revision}`;
      const request = createProjectFaviconRequest(
        lastCacheKey,
        `https://environment.example/api/assets/revision-${revision}/favicon.svg`,
      );
      const endRequest = beginProjectFaviconRequest(request);
      markProjectFaviconLoaded(request);
      endRequest();
    }

    expect(hasLoadedProjectFavicon(firstCacheKey)).toBe(false);
    expect(hasLoadedProjectFavicon(lastCacheKey)).toBe(true);
  });
});
