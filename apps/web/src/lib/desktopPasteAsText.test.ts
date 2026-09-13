import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { DESKTOP_PASTE_AS_TEXT_EVENT, installDesktopPasteAsText } from "./desktopPasteAsText";

describe("desktop paste as text", () => {
  it.each([false, true])("pastes with a mounted composer: %s", (hasComposer) => {
    const target = new EventTarget();
    let menuAction: ((action: string) => void) | undefined;
    const order: string[] = [];
    const bridge = {
      onMenuAction: (listener) => {
        menuAction = listener;
        return () => {
          menuAction = undefined;
        };
      },
      pasteAsText: vi.fn(async () => {
        order.push("paste");
      }),
    } satisfies Pick<DesktopBridge, "onMenuAction" | "pasteAsText">;
    if (hasComposer)
      target.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, () => order.push("armed"));
    const uninstall = installDesktopPasteAsText(bridge, target);
    menuAction?.("open-settings");
    expect(order).toEqual([]);
    menuAction?.("paste-as-text");
    expect(order).toEqual(hasComposer ? ["armed", "paste"] : ["paste"]);
    uninstall?.();
    menuAction?.("paste-as-text");
    expect(bridge.pasteAsText).toHaveBeenCalledOnce();
  });
});
