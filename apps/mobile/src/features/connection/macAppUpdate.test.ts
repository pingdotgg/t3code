import { describe, expect, it } from "vite-plus/test";

import { hostNeedsMacAppUpdate, parseLatestMacAppRelease } from "./macAppUpdate";

describe("mac app update advisory", () => {
  it("reads the newest Sparkle item", () => {
    expect(
      parseLatestMacAppRelease(`
        <rss><channel>
          <item>
            <sparkle:version>25</sparkle:version>
            <sparkle:shortVersionString>0.7.0</sparkle:shortVersionString>
          </item>
          <item>
            <sparkle:version>24</sparkle:version>
            <sparkle:shortVersionString>0.6.0</sparkle:shortVersionString>
          </item>
        </channel></rss>`),
    ).toEqual({ version: "0.7.0", buildNumber: 25 });
  });

  it("rejects malformed feeds", () => {
    expect(
      parseLatestMacAppRelease("<rss><item><sparkle:version>x</sparkle:version></item></rss>"),
    ).toBeNull();
  });

  it("uses the monotonic Sparkle build number", () => {
    const host = {
      name: "SurgeCode",
      version: "0.6.0",
      buildNumber: "24",
      updateCapability: "sparkle" as const,
    };
    expect(hostNeedsMacAppUpdate(host, { version: "0.7.0", buildNumber: 25 })).toBe(true);
    expect(hostNeedsMacAppUpdate(host, { version: "0.6.0", buildNumber: 24 })).toBe(false);
  });
});
