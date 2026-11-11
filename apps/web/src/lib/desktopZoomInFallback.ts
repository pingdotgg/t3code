import type { DesktopBridge } from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";

import { registerCommands } from "../shortcuts/dispatcher";

/**
 * macOS matches the Zoom In menu shortcut by US key position, so Cmd++ does nothing on layouts
 * with "+" elsewhere. Zoom the app when no keybinding (such as preview zoom) consumed the key.
 */
export function installDesktopZoomInFallback(
  bridge: Pick<DesktopBridge, "zoomAppIn"> | undefined,
  platform: string,
): (() => void) | undefined {
  if (!bridge || !isMacPlatform(platform)) return undefined;
  return registerCommands(
    {},
    {
      observe: (event, consumed) => {
        if (consumed || !event.metaKey || event.ctrlKey || event.altKey || event.key !== "+") {
          return;
        }
        // Keeps the US-layout menu accelerator from zooming a second time.
        event.preventDefault();
        void bridge.zoomAppIn();
      },
    },
  );
}
