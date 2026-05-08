import { afterEach, describe, expect, it, vi } from "vitest";

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
            baseName: "Forma",
            stageLabel: "Nightly",
            displayName: "Forma (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Forma");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Forma (Nightly)");
    expect(branding.APP_DEFAULT_ICON_ID).toBe("forma-nightly");
  });

  it("maps build stages to the expected default icon ids", async () => {
    const branding = await import("./branding");

    expect(branding.resolveDefaultBuildAppIconId("Alpha")).toBe("forma-prod");
    expect(branding.resolveDefaultBuildAppIconId("Nightly")).toBe("forma-nightly");
    expect(branding.resolveDefaultBuildAppIconId("Dev")).toBe("forma-dev");
  });
});
