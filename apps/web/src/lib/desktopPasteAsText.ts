import type { DesktopBridge } from "@t3tools/contracts";

export const DESKTOP_PASTE_AS_TEXT_EVENT = "t3:paste-as-text";

/** Arm composer paste handling before Electron delivers the native clipboard event. */
export function installDesktopPasteAsText(
  bridge: Pick<DesktopBridge, "onMenuAction" | "pasteAsText"> | undefined,
  target: EventTarget,
): (() => void) | undefined {
  return bridge?.onMenuAction((action) => {
    if (action !== "paste-as-text") return;
    target.dispatchEvent(new Event(DESKTOP_PASTE_AS_TEXT_EVENT));
    void bridge.pasteAsText?.();
  });
}
