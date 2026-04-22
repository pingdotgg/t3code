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
            baseName: "Harness",
            stageLabel: "Nightly",
            displayName: "Harness (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Harness");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Harness (Nightly)");
  });
});
