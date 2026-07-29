import { describe, expect, it } from "vite-plus/test";

import { hostNeedsMacAppUpdate, parseLatestMacAppRelease } from "./macAppUpdate";

describe("mac app update advisory", () => {
  it("selects the highest valid Sparkle build regardless of item order", () => {
    expect(
      parseLatestMacAppRelease(`
        <rss><channel>
          <item>
            <sparkle:version>24</sparkle:version>
            <sparkle:shortVersionString>0.6.0</sparkle:shortVersionString>
          </item>
          <item>
            <sparkle:version>25</sparkle:version>
            <sparkle:shortVersionString>0.7.0</sparkle:shortVersionString>
          </item>
        </channel></rss>`),
    ).toEqual({ version: "0.7.0", buildNumber: 25 });
  });

  it("ignores malformed items and rejects feeds without valid items", () => {
    expect(
      parseLatestMacAppRelease(`
        <rss>
          <item><sparkle:version>x</sparkle:version></item>
          <item>
            <sparkle:version>25</sparkle:version>
            <sparkle:shortVersionString>0.7.0</sparkle:shortVersionString>
          </item>
        </rss>`),
    ).toEqual({ version: "0.7.0", buildNumber: 25 });
    expect(
      parseLatestMacAppRelease(`
        <item>
          <sparkle:version>25-not-a-build</sparkle:version>
          <sparkle:shortVersionString>0.7.0</sparkle:shortVersionString>
        </item>`),
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
    expect(
      hostNeedsMacAppUpdate(
        { ...host, buildNumber: "24-old" },
        { version: "0.7.0", buildNumber: 25 },
      ),
    ).toBe(false);
    expect(
      hostNeedsMacAppUpdate(
        { ...host, updateCapability: "none" },
        { version: "0.7.0", buildNumber: 25 },
      ),
    ).toBe(false);
  });
});
