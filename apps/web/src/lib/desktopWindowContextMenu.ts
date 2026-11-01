import type { DesktopBridge } from "@t3tools/contracts";

import { showContextMenuFallback } from "../contextMenuFallback";

/** Draws the desktop shell's own right-click menu (spelling, links, editing) in the page. */
export function installDesktopWindowContextMenu(
  bridge: Pick<DesktopBridge, "onWindowContextMenu" | "resolveWindowContextMenu"> | undefined,
): (() => void) | undefined {
  return bridge?.onWindowContextMenu(({ requestId, items, position }) => {
    void showContextMenuFallback(items, position).then((itemId) =>
      bridge.resolveWindowContextMenu(requestId, itemId),
    );
  });
}
