import {
  DEFAULT_WINDOW_OPACITY,
  MAX_WINDOW_OPACITY,
  MIN_WINDOW_OPACITY,
  type DesktopWindowTransparencyMode,
} from "@t3tools/contracts";

/**
 * Electron's `setOpacity` only works on Windows and macOS. Linux has no window-level
 * opacity, so a window that should fade is created `transparent` and the renderer fades
 * its own content. `transparent` cannot be toggled after creation, which is why Linux
 * needs a restart the first time opacity drops below 100%.
 */
export function usesNativeWindowOpacity(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export function clampWindowOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return DEFAULT_WINDOW_OPACITY;
  return Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, Math.round(opacity)));
}

/** The fraction `BrowserWindow.setOpacity` takes. */
export function nativeWindowOpacity(opacity: number | undefined): number {
  return clampWindowOpacity(opacity) / 100;
}

export function shouldCreateTransparentWindow(
  platform: NodeJS.Platform,
  opacity: number | undefined,
): boolean {
  return !usesNativeWindowOpacity(platform) && clampWindowOpacity(opacity) < MAX_WINDOW_OPACITY;
}

export function resolveWindowTransparencyMode(input: {
  readonly platform: NodeJS.Platform;
  readonly createdTransparent: boolean;
}): DesktopWindowTransparencyMode {
  if (usesNativeWindowOpacity(input.platform)) return "native";
  return input.createdTransparent ? "compositor" : "restart-required";
}

const transparentWindows = new WeakSet<object>();

export function markCreatedTransparent(window: object): void {
  transparentWindows.add(window);
}

export function wasCreatedTransparent(window: object): boolean {
  return transparentWindows.has(window);
}
