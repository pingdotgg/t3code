import { useSyncExternalStore, type CSSProperties } from "react";

import { isElectron } from "./env";
import { isMacPlatform } from "./lib/utils";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

// Cache the synchronous fullscreen IPC read while anything is subscribed.
let windowFullscreenSnapshot: boolean | null = null;
let windowFullscreenSubscribers = 0;

function macosDesktopBridge() {
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;
  return window.desktopBridge ?? null;
}

function subscribeToWindowFullscreen(onChange: () => void): () => void {
  const bridge = macosDesktopBridge();
  if (
    typeof bridge?.getWindowFullscreenState !== "function" ||
    typeof bridge.onWindowFullscreenStateChange !== "function"
  ) {
    return () => {};
  }
  const unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
    windowFullscreenSnapshot = fullscreen;
    onChange();
  });
  // The window may have changed state between the first render and this subscription.
  if (windowFullscreenSubscribers === 0) {
    windowFullscreenSnapshot = bridge.getWindowFullscreenState();
  }
  windowFullscreenSubscribers += 1;
  return () => {
    unsubscribe();
    windowFullscreenSubscribers -= 1;
    if (windowFullscreenSubscribers === 0) windowFullscreenSnapshot = null;
  };
}

function readWindowFullscreen(): boolean {
  if (windowFullscreenSnapshot === null) {
    const getWindowFullscreenState = macosDesktopBridge()?.getWindowFullscreenState;
    windowFullscreenSnapshot =
      typeof getWindowFullscreenState === "function" ? getWindowFullscreenState() : false;
  }
  return windowFullscreenSnapshot;
}

// Portaled surfaces sit outside SidebarProvider, so each one applies this itself.
export function useWindowControlsInsetStyle(): CSSProperties {
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToWindowFullscreen,
    readWindowFullscreen,
  );
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  return (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
}
