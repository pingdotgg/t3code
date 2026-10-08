import { useEffect } from "react";

import { showContextMenuFallback } from "../../contextMenuFallback";

export function DesktopImageContextMenu() {
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onImageContextMenu || !bridge?.applyImageContextAction) return;
    return bridge.onImageContextMenu((payload) => {
      void showContextMenuFallback(
        [
          { id: "copy-image" as const, label: "Copy Image" },
          ...(payload.linkURL ? [{ id: "copy-link" as const, label: "Copy Link" }] : []),
        ],
        { x: payload.x, y: payload.y },
      ).then((action) => {
        if (action === "copy-image" || action === "copy-link")
          void bridge.applyImageContextAction(action);
      });
    });
  }, []);
  return null;
}
