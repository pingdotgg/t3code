export type ZoomMenuAction = "zoom-in" | "zoom-out" | "reset-zoom";

interface ZoomMenuWindow {
  readonly webContents: {
    isLoadingMainFrame: () => boolean;
    once: (event: "did-finish-load", listener: () => void) => unknown;
    send: (channel: string, action: ZoomMenuAction) => void;
  };
  isDestroyed: () => boolean;
}

export function dispatchZoomMenuAction(
  targetWindow: ZoomMenuWindow | null,
  channel: string,
  action: ZoomMenuAction,
): void {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  const send = () => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send(channel, action);
    }
  };
  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }
  send();
}
