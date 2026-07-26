import { describe, expect, it } from "vitest";

import { resolveDesktopAppBranding, resolveDesktopAppStageLabel } from "./appBranding.ts";

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

  it("uses Dev for packaged dev builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17",
        packageProductName: "T3 Code (Dev)",
      }),
    ).toBe("Dev");
  });

  it("uses Alpha for packaged stable builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17",
      }),
    ).toBe("Alpha");
  });

  it("brands packaged local alpha builds distinctly from upstream", () => {
    expect(
      resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.0.17",
        packageProductName: "T3 Code (Local Alpha)",
      }),
    ).toEqual({
      baseName: "T3 Code",
      stageLabel: "Alpha",
      displayName: "T3 Code (Local Alpha)",
    });
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
