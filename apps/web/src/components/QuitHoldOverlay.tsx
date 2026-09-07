import { useEffect, useState } from "react";

import { isMacPlatform } from "../lib/utils";

// A released hold hint lingers for the original hold duration. Double-press
// hints disappear as soon as their acceptance window closes.
const HOLD_HINT_LINGER_MS = 1200;

/**
 * The desktop main process intercepts the quit accelerator and pushes
 * press/release states while it waits for a hold or second press.
 */
export function QuitHoldOverlay() {
  const [visibleMode, setVisibleMode] = useState<"hold" | "double-click" | null>(null);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitShortcut;
    if (!subscribe) return;
    let hideTimer: number | undefined;
    let pressedMode: "hold" | "double-click" = "hold";
    const unsubscribe = subscribe((hint) => {
      window.clearTimeout(hideTimer);
      if (hint.state === "down") {
        pressedMode = hint.mode;
        setVisibleMode(hint.mode);
        return;
      }
      if (pressedMode === "double-click") {
        setVisibleMode(null);
        return;
      }
      hideTimer = window.setTimeout(() => setVisibleMode(null), HOLD_HINT_LINGER_MS);
    });
    return () => {
      window.clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  if (!visibleMode) return null;
  const shortcut = isMacPlatform(navigator.platform) ? "⌘Q" : "Ctrl+Q";
  const message =
    visibleMode === "hold"
      ? `Hold ${shortcut} or press twice to quit`
      : `Press ${shortcut} again to quit`;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      <div className="rounded-full bg-neutral-700/95 px-8 py-4 text-2xl font-bold text-white shadow-xl">
        {message}
      </div>
    </div>
  );
}
