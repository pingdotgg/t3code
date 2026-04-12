import { describe, expect, it, vi } from "vitest";

import { getWindowChromeOptions, getWindowControlsLayout } from "./env";

vi.mock("./linuxWindowControls", () => ({
  getLinuxWindowControlsLayout: vi.fn().mockReturnValue({
    left: [],
    right: ["minimize", "maximize", "close"],
  }),
}));

describe("getWindowControlsLayout", () => {
  it("uses the standard macOS traffic-light placement in ltr locales", () => {
    expect(getWindowControlsLayout({ locale: "en-US", platform: "macos" })).toEqual({
      left: ["close", "minimize", "maximize"],
      right: [],
    });
  });

  it("keeps macOS traffic lights left-aligned in rtl locales", () => {
    expect(getWindowControlsLayout({ locale: "ar", platform: "macos" })).toEqual({
      left: ["close", "minimize", "maximize"],
      right: [],
    });
  });

  it("uses the standard Windows control layout in ltr locales", () => {
    expect(getWindowControlsLayout({ locale: "en-US", platform: "windows" })).toEqual({
      left: [],
      right: ["minimize", "maximize", "close"],
    });
  });

  it("mirrors Windows controls in rtl locales", () => {
    expect(getWindowControlsLayout({ locale: "he", platform: "windows" })).toEqual({
      left: ["close", "maximize", "minimize"],
      right: [],
    });
  });

  it("keeps Linux layout unchanged even in rtl locales", () => {
    expect(getWindowControlsLayout({ locale: "ar", platform: "linux" })).toEqual({
      left: [],
      right: ["minimize", "maximize", "close"],
    });
  });
});

describe("getWindowChromeOptions", () => {
  it("uses transparent overlay and light symbols for windows in dark mode", () => {
    expect(
      getWindowChromeOptions({
        darkMode: true,
        linuxTitleBarMode: "native",
        platform: "windows",
      }),
    ).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        height: 52,
        color: "#00000000",
        symbolColor: "#ffffff",
      },
    });
  });

  it("uses transparent overlay and dark symbols for windows in light mode", () => {
    expect(
      getWindowChromeOptions({
        darkMode: false,
        linuxTitleBarMode: "native",
        platform: "windows",
      }),
    ).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        height: 52,
        color: "#00000000",
        symbolColor: "#000000",
      },
    });
  });

  it("keeps linux native titlebars unchanged", () => {
    expect(
      getWindowChromeOptions({
        darkMode: true,
        linuxTitleBarMode: "native",
        platform: "linux",
      }),
    ).toEqual({});
  });

  it("keeps linux overlay transparent workaround and applies symbol contrast", () => {
    expect(
      getWindowChromeOptions({
        darkMode: false,
        linuxTitleBarMode: "overlay",
        platform: "linux",
      }),
    ).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        height: 52,
        color: "#01000000",
        symbolColor: "#000000",
      },
    });
  });
});
