import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
  resolveWebAppStageLabel,
  resolveWindowTitle,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

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

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code (Nightly)");
  });

  it("does not label the latest hosted app channel", async () => {
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

  it("labels web builds by hosted channel before dev or production", () => {
    expect(resolveWebAppStageLabel({ hostedAppChannel: " Nightly", development: true })).toBe(
      "Nightly",
    );
    expect(resolveWebAppStageLabel({ hostedAppChannel: "latest", development: false })).toBe(
      "Latest",
    );
    expect(resolveWebAppStageLabel({ hostedAppChannel: "preview", development: true })).toBe("Dev");
    expect(resolveWebAppStageLabel({ hostedAppChannel: "", development: false })).toBe("Beta");
  });
});

describe("resolveWindowTitle", () => {
  const appDisplayName = "T3 Code (Nightly)";

  it("is the app name without a thread", () => {
    expect(
      resolveWindowTitle({ appDisplayName, projectTitle: null, threadTitle: null, desktop: true }),
    ).toBe(appDisplayName);
    expect(
      resolveWindowTitle({
        appDisplayName,
        projectTitle: "acme",
        threadTitle: "  ",
        desktop: true,
      }),
    ).toBe(appDisplayName);
  });

  it("names the project and thread, adding the app name only in browser tabs", () => {
    const input = { appDisplayName, projectTitle: "acme-web", threadTitle: "Fix login bug" };
    expect(resolveWindowTitle({ ...input, desktop: true })).toBe("acme-web / Fix login bug");
    expect(resolveWindowTitle({ ...input, desktop: false })).toBe(
      "acme-web / Fix login bug — T3 Code (Nightly)",
    );
  });

  it("drops the separator without a project title", () => {
    expect(
      resolveWindowTitle({
        appDisplayName,
        projectTitle: "  ",
        threadTitle: "Fix login bug",
        desktop: true,
      }),
    ).toBe("Fix login bug");
  });
});
