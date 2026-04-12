import type { DesktopWindowControlsLayout, Platform } from "@t3tools/contracts";
import type { LinuxTitleBarMode } from "@t3tools/contracts/settings";
import { DESKTOP_TITLEBAR_HEIGHT_PX } from "@t3tools/shared/desktop";
import type * as React from "react";
const DESKTOP_CHROME_MACOS_SAFE_INLINE_START_PX = 90;
const DESKTOP_CHROME_SAFE_INLINE_BASE_REM = 1;
const DESKTOP_CHROME_SAFE_INLINE_STEP_REM = 1.75;

export type DesktopChromeSafeAreaStyle = React.CSSProperties & {
  "--desktop-chrome-safe-inline-start"?: string;
  "--desktop-chrome-safe-inline-end"?: string;
  "--desktop-chrome-titlebar-height"?: string;
};

export function resolveDesktopChromeSafeInlineSize(controlCount: number): string {
  if (controlCount === 0) {
    return "0px";
  }
  return `${Math.max(0, controlCount) * DESKTOP_CHROME_SAFE_INLINE_STEP_REM + DESKTOP_CHROME_SAFE_INLINE_BASE_REM}rem`;
}

export function resolveDesktopChromeSafeAreaStyle(input: {
  leftControlCount: number;
  rightControlCount: number;
}): DesktopChromeSafeAreaStyle {
  const leftSafeInline = resolveDesktopChromeSafeInlineSize(input.leftControlCount);
  const rightSafeInline = resolveDesktopChromeSafeInlineSize(input.rightControlCount);

  return {
    "--desktop-chrome-safe-inline-start": leftSafeInline,
    "--desktop-chrome-safe-inline-end": rightSafeInline,
  };
}

function resolveDesktopChromeWcoSafeAreaStyle(): DesktopChromeSafeAreaStyle {
  return {
    "--desktop-chrome-safe-inline-start": "env(titlebar-area-x, 0px)",
    "--desktop-chrome-safe-inline-end":
      "calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px))",
    "--desktop-chrome-titlebar-height": `${DESKTOP_TITLEBAR_HEIGHT_PX}px`,
  };
}

export function resolveDesktopChromeRootStyle(input: {
  platform: Platform;
  linuxTitleBarMode: LinuxTitleBarMode;
  windowControlsLayout: DesktopWindowControlsLayout | null;
}): DesktopChromeSafeAreaStyle {
  if (input.platform === "macos") {
    return {
      "--desktop-chrome-safe-inline-start": `${DESKTOP_CHROME_MACOS_SAFE_INLINE_START_PX}px`,
      "--desktop-chrome-safe-inline-end": "0px",
      "--desktop-chrome-titlebar-height": `${DESKTOP_TITLEBAR_HEIGHT_PX}px`,
    };
  }

  if (
    input.platform === "linux" &&
    input.linuxTitleBarMode === "custom" &&
    input.windowControlsLayout
  ) {
    return {
      ...resolveDesktopChromeSafeAreaStyle({
        leftControlCount: input.windowControlsLayout.left.length,
        rightControlCount: input.windowControlsLayout.right.length,
      }),
      "--desktop-chrome-titlebar-height": `${DESKTOP_TITLEBAR_HEIGHT_PX}px`,
    };
  }

  if (
    input.platform === "windows" ||
    (input.platform === "linux" && input.linuxTitleBarMode === "overlay")
  ) {
    return resolveDesktopChromeWcoSafeAreaStyle();
  }

  return {
    "--desktop-chrome-safe-inline-start": "0px",
    "--desktop-chrome-safe-inline-end": "0px",
    "--desktop-chrome-titlebar-height": "0px",
  };
}
