import { describe, expect, it, vi } from "vite-plus/test";

import { createSoftwareKeyboardStore } from "./softwareKeyboard";

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

  it("reads keyboard geometry that was already present before subscribing", () => {
    const { store, keyboard } = fixture({ native: true });
    keyboard.boundingRect.height = 300;
    expect(store.getSnapshot()).toBe(true);
  });

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

  it("ignores window resizing even with a large height change", () => {
    const { store, resize, win } = fixture();
    const unsubscribe = store.subscribe(() => {});
    win.innerHeight = 500;
    resize(500);
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

  it("does not mistake an already zoomed viewport for an open keyboard", () => {
    const { store, resize } = fixture();
    resize(422, 195, 2);
    const unsubscribe = store.subscribe(() => {});
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

  it("shares listeners and refreshes state after the final subscriber leaves", () => {
    const { store, resize } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(first);
    const unsubscribeSecond = store.subscribe(second);
    resize(500);
    expect(store.getSnapshot()).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unsubscribeFirst();
    resize(550);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    resize(844);
    expect(second).toHaveBeenCalledTimes(2);

    const unsubscribe = store.subscribe(first);
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

  it("does not require browser APIs during server rendering", () => {
    const store = createSoftwareKeyboardStore(undefined, false);
    const unsubscribe = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });
});
