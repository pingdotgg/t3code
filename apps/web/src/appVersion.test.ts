import { describe, expect, it } from "vitest";

import { resolveDisplayedAppVersion } from "./appVersion";

describe("resolveDisplayedAppVersion", () => {
  it("prefers the Electron runtime version when available", () => {
    expect(
      resolveDisplayedAppVersion({
        buildVersion: "0.0.10",
        desktopAppVersion: "0.0.11",
      }),
    ).toBe("0.0.11");
  });

  it("falls back to the build version when Electron has not resolved a version yet", () => {
    expect(
      resolveDisplayedAppVersion({
        buildVersion: "0.0.10",
        desktopAppVersion: null,
      }),
    ).toBe("0.0.10");
  });

  it("ignores empty runtime versions", () => {
    expect(
      resolveDisplayedAppVersion({
        buildVersion: "0.0.10",
        desktopAppVersion: "   ",
      }),
    ).toBe("0.0.10");
  });
});
