import { describe, expect, it, vi } from "vite-plus/test";

import { createSoftwareKeyboardStore, pinShellToKeyboardViewport } from "./softwareKeyboard";

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

describe("pinning the shell to the keyboard viewport", () => {
  function pinFixture(desktop = false) {
    const viewport = Object.assign(new EventTarget(), { height: 1290, offsetTop: 0, scale: 1 });
    const properties = new Map<string, string>();
    const root = {
      clientHeight: 1290,
      dataset: {} as DOMStringMap,
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
      },
    };
    let onFocus: ((event: { target: unknown }) => void) | undefined;
    const document = {
      documentElement: root,
      addEventListener: (_type: string, listener: typeof onFocus) => (onFocus = listener),
      removeEventListener: () => (onFocus = undefined),
    };
    const frames: Array<() => void> = [];
    class FakeElement extends EventTarget {
      style = { opacity: "" };
    }
    const scrollTo = vi.fn(() => Object.assign(viewport, { offsetTop: 0 }));
    const stop = pinShellToKeyboardViewport(
      {
        visualViewport: viewport,
        document,
        scrollTo,
        requestAnimationFrame: (callback: () => void) => frames.push(callback),
      } as unknown as Window,
      desktop,
    );
    const move = (event: "resize" | "scroll", height: number, offsetTop: number, scale = 1) => {
      Object.assign(viewport, { height, offsetTop, scale });
      viewport.dispatchEvent(new Event(event));
    };
    const focus = () => {
      const field = new FakeElement();
      onFocus?.({ target: field });
      return field;
    };
    return { root, properties, stop, move, scrollTo, frames, focus };
  }

  // iPad Pro 13-inch Safari: the layout viewport keeps its height under the keyboard.
  it("sizes the shell to the keyboard and undoes Safari's scroll, then restores the layout", () => {
    const { root, properties, stop, move, scrollTo } = pinFixture();
    move("resize", 1222, 0);
    expect(root.dataset.keyboardViewport).toBeUndefined();

    move("resize", 887, 0);
    expect(root.dataset.keyboardViewport).toBe("");
    expect(Object.fromEntries(properties)).toEqual({ "--keyboard-viewport-height": "887px" });
    move("scroll", 887, 403);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    move("resize", 1290, 0);
    expect(root.dataset.keyboardViewport).toBeUndefined();
    expect(properties.size).toBe(0);

    move("resize", 400, 300, 2);
    expect(root.dataset.keyboardViewport).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    move("resize", 887, 0);
    stop();
    expect(root.dataset.keyboardViewport).toBeUndefined();
    expect(properties.size).toBe(0);
  });

  it("hides a field from Safari's reveal only until the next frame", () => {
    const { focus, frames } = pinFixture();
    const field = focus();
    expect(field.style.opacity).toBe("0");
    for (const frame of frames) frame();
    expect(field.style.opacity).toBe("");
  });

  it("never pins on desktop", () => {
    const { root, move, focus } = pinFixture(true);
    move("resize", 887, 0);
    expect(root.dataset.keyboardViewport).toBeUndefined();
    expect(focus().style.opacity).toBe("");
  });
});
