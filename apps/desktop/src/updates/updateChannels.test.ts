import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("brands preview builds like the stable app they are packaged as", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(false);
    expect(isNightlyDesktopVersion("0.0.41-nightly.20260911.7")).toBe(true);
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-nightly.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });
});
