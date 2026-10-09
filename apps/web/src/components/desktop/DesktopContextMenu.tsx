import { useEffect } from "react";

import { showContextMenuFallback } from "../../contextMenuFallback";

export function DesktopContextMenu() {
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onDesktopContextMenu || !bridge?.applyDesktopContextMenuAction) return;
    return bridge.onDesktopContextMenu((payload) => {
      void showContextMenuFallback(
        [
          ...(payload.copyImage ? [{ id: "copy-image" as const, label: "Copy Image" }] : []),
          ...(payload.linkURL ? [{ id: "copy-link" as const, label: "Copy Link" }] : []),
          ...(payload.selectAll ? [{ id: "select-all" as const, label: "Select All" }] : []),
        ],
        { x: payload.x, y: payload.y },
      ).then((action) => {
        if (action === "copy-image" || action === "copy-link")
          void bridge.applyDesktopContextMenuAction({ action, requestId: payload.requestId });
      });
    });
  }, []);
  return null;
}
