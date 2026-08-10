import { isWindowsPlatform } from "./utils";

const WCO_CLASS_NAME = "wco";
const ELECTRON_CLASS_NAME = "electron";
const ELECTRON_WINDOWS_CLASS_NAME = "electron-windows";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  readonly getTitlebarAreaRect: () => Pick<DOMRect, "width" | "right">;
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

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const overlay = getWindowControlsOverlay();
  if (!overlay) return () => {};

  const root = document.documentElement;
  const isWindows = isWindowsPlatform(navigator.platform);
  let wasVisible = overlay.visible;
  let hasGeometry = false;
  let fullscreen = isWindows && window.desktopBridge?.getWindowFullscreenState?.() === true;

  const applyGeometry = () => {
    const rect = overlay.getTitlebarAreaRect();
    const rightInset = window.innerWidth - rect.right;
    if (!(rect.width > 0 && rightInset > 0 && rightInset <= window.innerWidth)) return;

    root.style.setProperty("--workspace-native-controls-width", `${rightInset}px`);
    hasGeometry = true;
  };

  const update = () => {
    const visible = overlay.visible;
    const preserveWindowsLayout = isWindows && !visible && hasGeometry && !fullscreen;
    root.classList.toggle(WCO_CLASS_NAME, visible || preserveWindowsLayout);

    if (!isWindows) return;

    if (!visible) {
      wasVisible = false;
      return;
    }

    if (!wasVisible) {
      wasVisible = true;
      if (!hasGeometry) applyGeometry();
      return;
    }

    applyGeometry();
  };

  const stopFullscreenListener = isWindows
    ? window.desktopBridge?.onWindowFullscreenStateChange?.((value) => {
        fullscreen = value;
        update();
      })
    : undefined;

  update();

  overlay.addEventListener("geometrychange", update);
  return () => {
    stopFullscreenListener?.();
    overlay.removeEventListener("geometrychange", update);
    root.classList.remove(WCO_CLASS_NAME);
    root.style.removeProperty("--workspace-native-controls-width");
  };
}

export function getElectronPlatformClassNames(
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
