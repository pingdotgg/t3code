import type { DesktopPlatform, DesktopWindowControlsLayout } from "@t3tools/contracts";
import type { LinuxTitleBarMode } from "@t3tools/contracts/settings";
import { DESKTOP_TITLEBAR_HEIGHT_PX } from "@t3tools/shared/desktop";
import type { BrowserWindowConstructorOptions } from "electron";
import { getLinuxWindowControlsLayout } from "./linuxWindowControls";

const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "sd", "ug", "ur", "yi"]);
const MACOS_WINDOW_CONTROLS_LAYOUT: DesktopWindowControlsLayout = {
  left: ["close", "minimize", "maximize"],
  right: [],
};
const WINDOWS_WINDOW_CONTROLS_LAYOUT: DesktopWindowControlsLayout = {
  left: [],
  right: ["minimize", "maximize", "close"],
};
const WINDOW_CONTROL_SYMBOL_COLOR_DARK = "#ffffff";
const WINDOW_CONTROL_SYMBOL_COLOR_LIGHT = "#000000";
type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition"
>;

export const platform: DesktopPlatform = (() => {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported desktop platform: ${process.platform}`);
  }
})();

function isRightToLeftLocale(locale: string | undefined): boolean {
  if (!locale) {
    return false;
  }

  const language = locale.split(/[-_]/, 1)[0]?.toLowerCase();
  return language !== undefined && RTL_LANGUAGES.has(language);
}

function mirrorWindowControlsLayout(
  layout: DesktopWindowControlsLayout,
): DesktopWindowControlsLayout {
  return {
    left: layout.right.toReversed(),
    right: layout.left.toReversed(),
  };
}

export function getWindowControlsLayout(options?: {
  locale?: string;
  platform?: DesktopPlatform;
}): DesktopWindowControlsLayout {
  const resolvedPlatform = options?.platform ?? platform;
  if (resolvedPlatform === "linux") {
    return getLinuxWindowControlsLayout();
  }

  const rtl = isRightToLeftLocale(options?.locale);
  const layout =
    resolvedPlatform === "macos" ? MACOS_WINDOW_CONTROLS_LAYOUT : WINDOWS_WINDOW_CONTROLS_LAYOUT;

  if (!rtl || resolvedPlatform === "macos") {
    return layout;
  }

  return mirrorWindowControlsLayout(layout);
}

export function getWindowChromeOptions(input: {
  darkMode: boolean;
  linuxTitleBarMode: LinuxTitleBarMode;
  platform: DesktopPlatform;
}): WindowChromeOptions {
  const symbolColor = input.darkMode
    ? WINDOW_CONTROL_SYMBOL_COLOR_DARK
    : WINDOW_CONTROL_SYMBOL_COLOR_LIGHT;

  switch (input.platform) {
    case "macos":
      return {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: 18 },
      };

    case "linux":
      if (input.linuxTitleBarMode === "native") {
        return {};
      }

      if (input.linuxTitleBarMode === "overlay") {
        return {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            height: DESKTOP_TITLEBAR_HEIGHT_PX,
            color: "#01000000", // #00000000 doesn't work falling back to default value, not sure why, probably some bug in Electron
            symbolColor,
          },
        };
      }

      return {
        titleBarStyle: "hidden",
      };

    case "windows":
      return {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          height: DESKTOP_TITLEBAR_HEIGHT_PX,
          color: "#00000000",
          symbolColor,
        },
      };
  }
}
