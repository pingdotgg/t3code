import type { DesktopTitleBarMode, DesktopWindowState } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { useDesktopWindowState } from "~/hooks/useDesktopWindowState";
import { useSettings } from "~/hooks/useSettings";
import { isMacPlatform } from "~/lib/utils";

export function resolveShouldUseDesktopHeaderDragRegion(input: {
  windowState: DesktopWindowState | null;
  desktopTitleBarMode: DesktopTitleBarMode;
}): boolean {
  if (!isElectron) {
    return false;
  }

  const { windowState, desktopTitleBarMode } = input;

  if (!windowState) {
    return desktopTitleBarMode === "t3code" || isMacPlatform(navigator.platform);
  }

  if (windowState.platform === "other") {
    return false;
  }

  return windowState.titleBarMode === "t3code" || windowState.platform === "darwin";
}

export function useShouldUseDesktopHeaderDragRegion(): boolean {
  const windowState = useDesktopWindowState();
  const desktopTitleBarMode = useSettings().desktopTitleBarMode;

  return resolveShouldUseDesktopHeaderDragRegion({
    windowState,
    desktopTitleBarMode,
  });
}
