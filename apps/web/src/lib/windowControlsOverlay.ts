import { useSyncExternalStore } from "react";

import { isElectron } from "~/env";

import { isMacPlatform, isWindowsPlatform } from "./utils";

const WCO_CLASS_NAME = "wco";
const ELECTRON_CLASS_NAME = "electron";
const ELECTRON_WINDOWS_CLASS_NAME = "electron-windows";
// macOS has no overlay API; traffic lights stay inside this topbar at every zoom level.
const MACOS_TITLEBAR_HEIGHT = 52;

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

/** Height of the native caption strip drawn over the page, or 0 when the window has none. */
export function windowControlsOverlayHeight(): number {
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().height : 0;
}

export function onWindowControlsOverlayGeometryChange(listener: () => void): () => void {
  const overlay = getWindowControlsOverlay();
  if (!overlay) {
    return () => {};
  }

  overlay.addEventListener("geometrychange", listener);
  return () => {
    overlay.removeEventListener("geometrychange", listener);
  };
}

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const overlay = getWindowControlsOverlay();
  // Windows also empties the overlay while minimized; dropping the class then shifts the layout
  // on restore. Fullscreen empties it for real, so only fullscreen may drop it there.
  const keepsClassUnlessFullscreen = isElectron && isWindowsPlatform(navigator.platform);
  const update = () => {
    const visible = overlay !== null && overlay.visible;
    if (
      !visible &&
      keepsClassUnlessFullscreen &&
      !window.desktopBridge?.getWindowFullscreenState()
    ) {
      return;
    }
    document.documentElement.classList.toggle(WCO_CLASS_NAME, visible);
  };

  update();
  const stopGeometry = onWindowControlsOverlayGeometryChange(update);
  if (!keepsClassUnlessFullscreen) return stopGeometry;
  // The overlay can hide before the window reports fullscreen; the fullscreen resize settles it.
  window.addEventListener("resize", update);
  return () => {
    stopGeometry();
    window.removeEventListener("resize", update);
  };
}

function subscribeTitlebarArea(listener: () => void): () => void {
  const overlay = getWindowControlsOverlay();
  overlay?.addEventListener("geometrychange", listener);
  return () => overlay?.removeEventListener("geometrychange", listener);
}

function getNativeTitlebarHeight(): number {
  if (isElectron && isMacPlatform(navigator.platform)) return MACOS_TITLEBAR_HEIGHT;
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0;
}

export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribeTitlebarArea, getNativeTitlebarHeight, () => 0);
}

function getElectronPlatformClassNames(
  platform: string,
):
  | readonly [typeof ELECTRON_CLASS_NAME]
  | readonly [typeof ELECTRON_CLASS_NAME, typeof ELECTRON_WINDOWS_CLASS_NAME] {
  return isWindowsPlatform(platform)
    ? [ELECTRON_CLASS_NAME, ELECTRON_WINDOWS_CLASS_NAME]
    : [ELECTRON_CLASS_NAME];
}

export function syncDocumentElectronPlatformClasses(platform: string): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const classNames = getElectronPlatformClassNames(platform);
  document.documentElement.classList.add(...classNames);
  return () => {
    document.documentElement.classList.remove(...classNames);
  };
}
