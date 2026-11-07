type VirtualKeyboard = EventTarget & {
  readonly boundingRect: Pick<DOMRectReadOnly, "height">;
  readonly overlaysContent: boolean;
};

type KeyboardWindow = Pick<Window, "innerHeight" | "visualViewport"> & {
  readonly navigator: Navigator & { readonly virtualKeyboard?: VirtualKeyboard };
};

const KEYBOARD_THRESHOLD = 150;

function viewportSnapshot(viewport: VisualViewport) {
  return {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    scale: viewport.scale,
  };
}

export function createSoftwareKeyboardStore(win: KeyboardWindow | undefined, isDesktop: boolean) {
  const listeners = new Set<() => void>();
  let viewportOpen = false;
  const viewport = isDesktop ? undefined : win?.visualViewport;
  const keyboard = isDesktop ? undefined : win?.navigator.virtualKeyboard;
  let previous = viewport ? viewportSnapshot(viewport) : undefined;

  const getSnapshot = () => {
    // Chromium can expose the API while withholding geometry outside overlay mode.
    // Keep the browser's automatic viewport resizing instead of enabling overlays.
    if (keyboard && (keyboard.overlaysContent || keyboard.boundingRect.height > 0)) {
      return keyboard.boundingRect.height > 0;
    }
    return viewportOpen;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const onViewportResize = () => {
    if (!viewport || !win) return;
    const current = viewportSnapshot(viewport);
    // Adapted from Ionic's keyboard assist, MIT, Copyright (c) 2015-present Drifty Co.
    // https://github.com/ionic-team/ionic-framework/blob/main/core/src/utils/keyboard/keyboard.ts
    const scaledHeightDifference = previous
      ? (previous.height - current.height) * current.scale
      : 0;
    if (Math.abs(current.height - win.innerHeight / current.scale) <= 1) {
      viewportOpen = false;
    } else if (
      !viewportOpen &&
      previous?.width === current.width &&
      scaledHeightDifference > KEYBOARD_THRESHOLD
    ) {
      viewportOpen = true;
    }
    previous = current;
    notify();
  };

  const subscribe = (listener: () => void) => {
    if (isDesktop || !win) return () => {};
    if (listeners.size === 0) {
      if (viewport) {
        previous = viewportSnapshot(viewport);
        // A composer can mount after the keyboard has already opened.
        viewportOpen = win.innerHeight - previous.height * previous.scale > KEYBOARD_THRESHOLD;
        viewport.addEventListener("resize", onViewportResize);
      }
      keyboard?.addEventListener("geometrychange", notify);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        viewport?.removeEventListener("resize", onViewportResize);
        keyboard?.removeEventListener("geometrychange", notify);
      }
    };
  };

  return { getSnapshot, subscribe };
}

type ViewportGeometry = Pick<VisualViewport, "height" | "offsetTop" | "scale">;

/**
 * The visible area while an on-screen keyboard overlays the layout viewport, or null when the
 * layout already fits it. Safari ignores `interactive-widget=resizes-content`, so only there does
 * the visual viewport lose height; `innerHeight` follows the keyboard on iPadOS, so callers pass
 * a stable layout height such as `documentElement.clientHeight`.
 */
export function measureKeyboardViewport(layoutHeight: number, viewport: ViewportGeometry) {
  // Pinch zoom shrinks the visual viewport too, and the page must stay pannable then.
  if (viewport.scale > 1.01) return null;
  const height = Math.round(viewport.height);
  if (layoutHeight - height <= KEYBOARD_THRESHOLD) return null;
  return { height, offsetTop: Math.max(0, Math.round(viewport.offsetTop)) };
}

type PinWindow = Pick<Window, "visualViewport"> & {
  readonly document: { readonly documentElement: HTMLElement };
};

/** Pins the app shell to the visible area while a keyboard overlays it; see index.css. */
export function pinShellToKeyboardViewport(win: PinWindow, isDesktop: boolean): () => void {
  const viewport = win.visualViewport;
  if (isDesktop || !viewport) return () => {};
  const root = win.document.documentElement;
  let pinned = "";

  const unpin = () => {
    pinned = "";
    delete root.dataset.keyboardViewport;
    root.style.removeProperty("--keyboard-viewport-height");
    root.style.removeProperty("--keyboard-viewport-top");
  };

  const update = () => {
    const area = measureKeyboardViewport(root.clientHeight, viewport);
    const next = area ? `${area.height}:${area.offsetTop}` : "";
    if (next === pinned) return;
    if (!area) {
      unpin();
      return;
    }
    pinned = next;
    root.style.setProperty("--keyboard-viewport-height", `${area.height}px`);
    root.style.setProperty("--keyboard-viewport-top", `${area.offsetTop}px`);
    root.dataset.keyboardViewport = "";
  };

  update();
  // Safari pans the visual viewport with scroll events alone while it reveals a focused field.
  viewport.addEventListener("resize", update, { passive: true });
  viewport.addEventListener("scroll", update, { passive: true });
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    unpin();
  };
}
