import type * as Electron from "electron";
import type * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
export const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 780 } as const;
// Fits half and third tiles of common scaled displays (down to 480x432 DIP) on
// Wayland, where Electron's client-side frame adds 32x42 DIP to the enforced
// minimum. The web layout already handles phone widths.
export const MIN_MAIN_WINDOW_SIZE = {
  width: 400,
  height: 360,
} as const;
const TITLEBAR_HEIGHT = 40;
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

export function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#000000" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

// A window snapped to a display edge can be reported 1px past that edge.
const SAVED_BOUNDS_EDGE_TOLERANCE_PX = 1;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  const tolerance = SAVED_BOUNDS_EDGE_TOLERANCE_PX;
  return (
    windowBounds.x >= displayBounds.x - tolerance &&
    windowBounds.y >= displayBounds.y - tolerance &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width + tolerance &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height + tolerance
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DEFAULT_MAIN_WINDOW_SIZE;
}

export function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}
export function normalizeMainWindowBounds(
  value: unknown,
): DesktopAppSettings.DesktopWindowBounds | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value) ||
    !("width" in value) ||
    !("height" in value)
  )
    return null;
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    !Number.isInteger(x) ||
    typeof y !== "number" ||
    !Number.isInteger(y) ||
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width < MIN_MAIN_WINDOW_SIZE.width ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height < MIN_MAIN_WINDOW_SIZE.height
  )
    return null;
  return { x, y, width, height };
}

export function mainWindowOptions(input: {
  readonly bounds: ReturnType<typeof resolveInitialMainWindowBounds>;
  readonly platform: NodeJS.Platform;
  readonly shouldUseDarkColors: boolean;
  readonly title: string;
  readonly preloadPath: string;
  readonly icon?: string;
}): Electron.BrowserWindowConstructorOptions {
  return {
    ...input.bounds,
    minWidth: MIN_MAIN_WINDOW_SIZE.width,
    minHeight: MIN_MAIN_WINDOW_SIZE.height,
    show: false,
    autoHideMenuBar: true,
    ...(input.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
    backgroundColor: getInitialWindowBackgroundColor(input.shouldUseDarkColors),
    ...(input.icon ? { icon: input.icon } : {}),
    title: input.title,
    ...getWindowTitleBarOptions(input.shouldUseDarkColors, input.platform),
    webPreferences: {
      preload: input.preloadPath,
      // Hidden-renderer throttling stalls first paint; re-enable it after the first reveal.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Guest fullscreen propagates to the embedder; both must opt out to keep it inside the webview.
      // The app's own fullscreen elements reach OS fullscreen through syncHtmlFullscreen.
      disableHtmlFullscreenWindowResize: true,
    },
  };
}
