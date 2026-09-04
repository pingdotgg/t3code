import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveHostedAppChannelLabel,
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
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

  it("labels hosted channels and rejects everything else", () => {
    expect(resolveHostedAppChannelLabel("nightly")).toBe("Nightly");
    expect(resolveHostedAppChannelLabel("Latest ")).toBe("Latest");
    expect(resolveHostedAppChannelLabel("preview")).toBeNull();
    expect(resolveHostedAppChannelLabel("")).toBeNull();
    expect(resolveHostedAppChannelLabel(undefined)).toBeNull();
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
});

describe("resolveWindowTitle", () => {
  it("falls back to the app display name without an active thread", () => {
    expect(
      resolveWindowTitle({
        appDisplayName: "T3 Code (Nightly)",
        projectTitle: null,
        threadTitle: null,
        desktop: true,
      }),
    ).toBe("T3 Code (Nightly)");
  });

  it("joins project and thread titles on desktop without the app name", () => {
    expect(
      resolveWindowTitle({
        appDisplayName: "T3 Code (Nightly)",
        projectTitle: "acme-web",
        threadTitle: "New thread",
        desktop: true,
      }),
    ).toBe("acme-web / New thread");
  });

  it("keeps the app display name as a suffix on the web", () => {
    expect(
      resolveWindowTitle({
        appDisplayName: "T3 Code (Alpha)",
        projectTitle: "acme-web",
        threadTitle: "New thread",
        desktop: false,
      }),
    ).toBe("acme-web / New thread — T3 Code (Alpha)");
  });

  it("omits the separator without a project title", () => {
    expect(
      resolveWindowTitle({
        appDisplayName: "T3 Code (Nightly)",
        projectTitle: "  ",
        threadTitle: "Fix login bug",
        desktop: true,
      }),
    ).toBe("Fix login bug");
  });

  it("ignores whitespace-only thread titles", () => {
    expect(
      resolveWindowTitle({
        appDisplayName: "T3 Code (Nightly)",
        projectTitle: "acme-web",
        threadTitle: "  ",
        desktop: true,
      }),
    ).toBe("T3 Code (Nightly)");
  });
});
