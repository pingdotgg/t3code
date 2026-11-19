import { describe, expect, it } from "vite-plus/test";

import { createContentBlocker, normalizeHostEntry } from "./contentBlocking.ts";

const config = {
  enabled: true,
  lists: ["trackers", "youtube-ads"],
  customHosts: ["https://ads.example.com/path"],
  allowlist: ["news.example.org"],
};

describe("createContentBlocker", () => {
  const blocker = createContentBlocker(config);

  it.each([
    ["https://www.google-analytics.com/g/collect", "https://site.test/", true],
    ["https://sub.hotjar.com/x.js", null, true],
    ["https://www.youtube.com/api/stats/ads?x=1", "https://www.youtube.com/watch?v=a", true],
    ["https://www.youtube.com/youtubei/v1/player", "https://www.youtube.com/watch?v=a", false],
    ["https://ads.example.com/banner.js", "https://site.test/", true],
    ["https://notgoogle-analytics.com/x", "https://site.test/", false],
    ["https://www.google-analytics.com/g/collect", "https://news.example.org/a", false],
    ["https://doubleclick.net/x", "https://site.test/", false],
    ["chrome-extension://abc/x.js", "https://site.test/", false],
  ])("%s on %s blocks: %s", (url, page, expected) => {
    expect(blocker.shouldBlock(url, page)).toBe(expected);
  });

  it("blocks nothing when off", () => {
    const off = createContentBlocker({ ...config, enabled: false });
    expect(off.active).toBe(false);
    expect(off.shouldBlock("https://www.google-analytics.com/x", null)).toBe(false);
  });
});

describe("normalizeHostEntry", () => {
  it.each([
    ["www.Example.com", "example.com"],
    ["https://a.b.co/path?q", "a.b.co"],
    ["localhost", null],
    ["", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHostEntry(input)).toBe(expected);
  });
});
