import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { registerCommands } from "../shortcuts/dispatcher";
import { installDesktopZoomInFallback } from "./desktopZoomInFallback";

const previewZoomIn: ResolvedKeybindingsConfig = [
  {
    command: "preview.zoomIn",
    shortcut: {
      key: "+",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  },
];

// A German or Swiss layout types "+" on BracketRight without Shift.
function pressCommandPlus(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "+",
    code: "BracketRight",
    metaKey: true,
    cancelable: true,
    bubbles: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("installDesktopZoomInFallback", () => {
  it("zooms the app only when no keybinding consumed Cmd++", () => {
    const zoomAppIn = vi.fn(async () => {});
    const previewZoom = vi.fn();
    using stack = new DisposableStack();
    stack.defer(installDesktopZoomInFallback({ zoomAppIn }, "MacIntel") ?? (() => {}));

    expect(pressCommandPlus().defaultPrevented).toBe(true);
    expect(zoomAppIn).toHaveBeenCalledOnce();

    stack.defer(
      registerCommands(
        { "preview.zoomIn": previewZoom },
        { keybindings: () => previewZoomIn, context: () => ({ previewFocus: true }) },
      ),
    );
    pressCommandPlus();
    expect(previewZoom).toHaveBeenCalledOnce();
    expect(zoomAppIn).toHaveBeenCalledOnce();
  });
});
