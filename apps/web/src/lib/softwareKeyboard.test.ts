import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSoftwareKeyboardStore,
  measureKeyboardViewport,
  pinShellToKeyboardViewport,
} from "./softwareKeyboard";

function fixture(options: { native?: boolean; overlay?: boolean; desktop?: boolean } = {}) {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, scale: 1 });
  const keyboard = Object.assign(new EventTarget(), {
    boundingRect: { height: 0 },
    overlaysContent: options.overlay ?? false,
  });
  const win = {
    innerHeight: 844,
    visualViewport: viewport,
    navigator: options.native ? { virtualKeyboard: keyboard } : {},
  };
  const store = createSoftwareKeyboardStore(win as unknown as Window, options.desktop ?? false);
  const resize = (height: number, width = viewport.width, scale = viewport.scale) => {
    Object.assign(viewport, { height, width, scale });
    viewport.dispatchEvent(new Event("resize"));
  };
  const geometry = (height: number) => {
    keyboard.boundingRect.height = height;
    keyboard.dispatchEvent(new Event("geometrychange"));
  };
  return { store, viewport, keyboard, win, resize, geometry };
}

describe("software keyboard detection", () => {
  it("follows native keyboard geometry even when the viewport does not resize", () => {
    const { store, geometry } = fixture({ native: true, overlay: true });
    const observed: boolean[] = [];
    const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
    expect(store.getSnapshot()).toBe(false);

    geometry(300);
    expect(store.getSnapshot()).toBe(true);
    geometry(0);
    expect(store.getSnapshot()).toBe(false);
    expect(observed).toEqual([true, false]);

    unsubscribe();
    geometry(300);
    expect(observed).toEqual([true, false]);
  });

  // regression: #21763 composer Enter sent instead of inserting a newline on software keyboards
  it("prefers overlay geometry over a misleading viewport height", () => {
    const { store, resize, geometry } = fixture({ native: true, overlay: true });
    const unsubscribe = store.subscribe(() => {});
    resize(500);
    expect(store.getSnapshot()).toBe(false);
    geometry(300);
    expect(store.getSnapshot()).toBe(true);
    geometry(0);
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  it.each([false, true])("falls back to viewport changes with native API present: %s", (native) => {
    const { store, resize, keyboard } = fixture({ native });
    const unsubscribe = store.subscribe(() => {});

    resize(500);
    expect(store.getSnapshot()).toBe(true);
    resize(550);
    expect(store.getSnapshot()).toBe(true);
    resize(844);
    expect(store.getSnapshot()).toBe(false);
    expect(keyboard.overlaysContent).toBe(false);
    unsubscribe();
  });

  // regression: #21763 composer Enter sent instead of inserting a newline on software keyboards
  it("detects a docked keyboard when subscribing after it has opened", () => {
    const { store, resize } = fixture();
    resize(500);
    const unsubscribe = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(true);
    resize(844);
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  it("ignores small height changes such as the browser toolbar", () => {
    const { store, resize } = fixture();
    const unsubscribe = store.subscribe(() => {});
    resize(750);
    expect(store.getSnapshot()).toBe(false);
    resize(700);
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  it("ignores pinch zoom and recognizes keyboard changes at the new scale", () => {
    const { store, resize } = fixture();
    const unsubscribe = store.subscribe(() => {});
    resize(422, 195, 2);
    expect(store.getSnapshot()).toBe(false);
    resize(300);
    expect(store.getSnapshot()).toBe(true);
    resize(422);
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  it("does not mistake rotation for an open keyboard", () => {
    const { store, resize, win } = fixture();
    const unsubscribe = store.subscribe(() => {});
    win.innerHeight = 390;
    resize(390, 844);
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  it("recognizes keyboard closure despite viewport rounding at high zoom", () => {
    const { store, resize } = fixture();
    resize(211, 98, 4);
    const unsubscribe = store.subscribe(() => {});
    resize(150);
    expect(store.getSnapshot()).toBe(true);
    resize(210.6);
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  it("bypasses both native geometry and viewport detection on desktop", () => {
    const { store, geometry, resize } = fixture({ native: true, overlay: true, desktop: true });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    geometry(300);
    resize(500);
    expect(store.getSnapshot()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("keyboard viewport measurement", () => {
  // Measured on an iPad Pro 13-inch in portrait, where innerHeight follows the keyboard.
  it("measures the visible area Safari panned to under a docked keyboard", () => {
    expect(measureKeyboardViewport(1244, { height: 841, offsetTop: 403, scale: 1 })).toEqual({
      height: 841,
      offsetTop: 403,
    });
  });

  it("leaves the layout alone without a keyboard or with only the shortcut bar", () => {
    expect(measureKeyboardViewport(1244, { height: 1244, offsetTop: 0, scale: 1 })).toBeNull();
    expect(measureKeyboardViewport(1244, { height: 1176, offsetTop: 0, scale: 1 })).toBeNull();
  });

  it("leaves a keyboard that already resized the layout viewport to the browser", () => {
    expect(measureKeyboardViewport(444, { height: 444, offsetTop: 0, scale: 1 })).toBeNull();
  });

  it("stands down while pinch-zoomed", () => {
    expect(measureKeyboardViewport(1244, { height: 400, offsetTop: 300, scale: 2 })).toBeNull();
  });
});

describe("pinning the shell to the keyboard viewport", () => {
  function pinFixture(desktop = false) {
    const viewport = Object.assign(new EventTarget(), { height: 1244, offsetTop: 0, scale: 1 });
    const properties = new Map<string, string>();
    const setProperty = vi.fn((key: string, value: string) => properties.set(key, value));
    const root = {
      clientHeight: 1244,
      dataset: {} as DOMStringMap,
      style: { setProperty, removeProperty: (key: string) => properties.delete(key) },
    };
    const stop = pinShellToKeyboardViewport(
      { visualViewport: viewport, document: { documentElement: root } } as unknown as Window,
      desktop,
    );
    const move = (event: "resize" | "scroll", height: number, offsetTop: number) => {
      Object.assign(viewport, { height, offsetTop });
      viewport.dispatchEvent(new Event(event));
    };
    return { root, properties, setProperty, stop, move };
  }

  it("follows the keyboard and Safari's pan, then restores the layout when it closes", () => {
    const { root, properties, setProperty, stop, move } = pinFixture();
    expect(root.dataset.keyboardViewport).toBeUndefined();

    move("resize", 841, 0);
    move("scroll", 841, 403);
    expect(root.dataset.keyboardViewport).toBe("");
    expect(Object.fromEntries(properties)).toEqual({
      "--keyboard-viewport-height": "841px",
      "--keyboard-viewport-top": "403px",
    });
    const writes = setProperty.mock.calls.length;
    move("scroll", 841, 403);
    expect(setProperty.mock.calls.length).toBe(writes);

    move("resize", 1244, 0);
    expect(root.dataset.keyboardViewport).toBeUndefined();
    expect(properties.size).toBe(0);

    move("resize", 841, 403);
    stop();
    expect(root.dataset.keyboardViewport).toBeUndefined();
    expect(properties.size).toBe(0);
  });

  it("never pins on desktop", () => {
    const { root, move } = pinFixture(true);
    move("resize", 841, 403);
    expect(root.dataset.keyboardViewport).toBeUndefined();
  });
});
