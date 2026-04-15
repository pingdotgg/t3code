import { describe, expect, it } from "vitest";

import { resolveDesktopAppBranding, resolveDesktopAppStageLabel } from "./appBranding";

describe("resolveDesktopAppStageLabel", () => {
  it("uses Dev in desktop development", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: true,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toBe("Dev");
  });

  it("uses Nightly for packaged nightly builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toBe("Nightly");
  });

  it("uses Alpha for packaged stable builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17",
      }),
    ).toBe("Alpha");
  });
});

describe("resolveDesktopAppBranding", () => {
  it("returns a complete desktop branding payload", () => {
    expect(
      resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toEqual({
      baseName: "T3 Code",
      stageLabel: "Nightly",
      displayName: "T3 Code (Nightly)",
    });
  });
});
