import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  formatDisplayedAppVersion,
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "T3 Code",
            stageLabel: "Nightly",
            displayName: "T3 Code (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("T3 Code");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code (Nightly)");
  });

  it("keeps a single-channel desktop build off update tracks under any name", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "T3 Code",
            stageLabel: "Beta",
            displayName: "T3 Code",
            singleReleaseChannel: true,
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("T3 Code");
    expect(branding.APP_HAS_UPDATE_TRACKS).toBe(false);
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code");
  });

  it("does not apply a Nightly stage to MT Code", async () => {
    vi.stubEnv("VITE_APP_BASE_NAME", "MT Code");
    vi.stubEnv("VITE_APP_STAGE_LABEL", "Nightly");
    vi.stubEnv("VITE_APP_DISPLAY_NAME", "MT Code");

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("MT Code");
    expect(branding.APP_HAS_UPDATE_TRACKS).toBe(false);
    expect(branding.APP_STAGE_LABEL).not.toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("MT Code");
  });

  it("normalizes hosted app channel metadata", async () => {
    // Hosted channel labels only apply to a build that HAS update tracks; the
    // fork's default build deliberately has none, so name the
    // tracked build explicitly rather than leaning on the default.
    vi.stubEnv("VITE_APP_BASE_NAME", "T3 Code");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code (Nightly)");
  });

  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_APP_BASE_NAME", "T3 Code");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code");
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("T3 Code (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it("strips the nightly prerelease from displayed versions", () => {
    expect(formatDisplayedAppVersion({ version: "0.0.34-nightly.20260818.1127" })).toBe("0.0.34");
  });

  it("keeps the nightly prerelease when stripping is disabled", () => {
    expect(
      formatDisplayedAppVersion({
        version: "0.0.34-nightly.20260818.1127",
        stripNightlyPrerelease: false,
      }),
    ).toBe("0.0.34-nightly.20260818.1127");
  });

  it("does not label MT Code servers as Nightly", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
        allowNightlyStage: false,
      }),
    ).toBe("Alpha");
  });
});
