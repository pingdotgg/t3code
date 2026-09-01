import { useEffect, useState } from "react";

import { getClientSettings } from "../hooks/useSettings";
import { isMacPlatform } from "../lib/utils";

// Matches the hold duration in apps/desktop/src/window/QuitHold.ts: the hint
// from a quick tap lingers for as long as a full hold would have taken.
const HIDE_AFTER_RELEASE_MS = 1200;

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
    const unsubscribe = subscribe((state) => {
      window.clearTimeout(hideTimer);
      if (state === "down") {
        const mode = getClientSettings().confirmQuit;
        setVisibleMode(mode === "double-click" ? mode : "hold");
        return;
      }
      hideTimer = window.setTimeout(() => setVisibleMode(null), HIDE_AFTER_RELEASE_MS);
    });
    return () => {
      window.clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  if (!visibleMode) return null;
  const shortcut = isMacPlatform(navigator.platform) ? "⌘Q" : "Ctrl+Q";
  const message =
    visibleMode === "hold" ? `Hold ${shortcut} to Quit` : `Press ${shortcut} again to Quit`;
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
