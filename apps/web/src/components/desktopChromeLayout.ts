import type * as React from "react";

export const DESKTOP_CHROME_TITLEBAR_HEIGHT_PX = 52;
const DESKTOP_CHROME_SAFE_INLINE_BASE_REM = 1;
const DESKTOP_CHROME_SAFE_INLINE_STEP_REM = 1.75;

export type DesktopChromeSafeAreaStyle = React.CSSProperties & {
  "--desktop-chrome-safe-inline-start"?: string;
  "--desktop-chrome-safe-inline-end"?: string;
  "--desktop-chrome-titlebar-height"?: string;
};

export function resolveDesktopChromeSafeInlineSize(controlCount: number): string {
  if (controlCount === 0) {
    return "0";
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
