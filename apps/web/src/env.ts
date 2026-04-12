import type { DesktopWindowControlsLayout, Platform } from "@t3tools/contracts";
import { DEFAULT_LINUX_TITLE_BAR_MODE, type LinuxTitleBarMode } from "@t3tools/contracts/settings";

export const desktopPlatform: Platform =
  typeof window === "undefined" ? "web" : (window.desktopBridge?.getPlatform?.() ?? "web");
export const isElectron = desktopPlatform !== "web";
export const runningLinuxTitleBarMode: LinuxTitleBarMode =
  desktopPlatform === "linux"
    ? (window.desktopBridge?.getLinuxTitleBarMode?.() ?? DEFAULT_LINUX_TITLE_BAR_MODE)
    : DEFAULT_LINUX_TITLE_BAR_MODE;
export const windowControlsLayout: DesktopWindowControlsLayout | null =
  typeof window === "undefined"
    ? null
    : (window.desktopBridge?.getWindowControlsLayout?.() ?? null);
export const usesWCO =
  desktopPlatform === "windows" ||
  (desktopPlatform === "linux" && runningLinuxTitleBarMode === "overlay");

export function shouldRenderDesktopChromeHeader(options?: {
  platform?: Platform;
  linuxTitleBarMode?: LinuxTitleBarMode;
}): boolean {
  const resolvedPlatform = options?.platform ?? desktopPlatform;
  if (resolvedPlatform === "web") {
    return false;
  }

  if (resolvedPlatform === "linux") {
    const resolvedLinuxTitleBarMode = options?.linuxTitleBarMode ?? runningLinuxTitleBarMode;
    return resolvedLinuxTitleBarMode !== "native";
  }

  return true;
}

export const usesDesktopChromeHeader = shouldRenderDesktopChromeHeader();
