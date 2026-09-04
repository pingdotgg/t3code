import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeSelectionActions, resolveSelectionActionPosition } from "./selectionActions";

function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), values);
}

function createSelectionSurface({ interactiveActions = false } = {}) {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const view = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const document = Object.assign(new EventTarget(), {
    defaultView: view,
    activeElement: null as EventTarget | null,
  });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (target: unknown): boolean => target === element,
  });
  const onSelection = vi.fn();
  const onDismiss = vi.fn();
  const field = new EventTarget();
  const actionElement = Object.assign(new EventTarget(), {
    contains: (target: unknown) => target === actionElement || target === field,
  });
  const actions = observeSelectionActions({
    element: element as unknown as HTMLElement,
    ...(interactiveActions
      ? { getActionElement: () => actionElement as unknown as HTMLElement }
      : {}),
    onSelection,
    onDismiss,
  });
  document.addEventListener("selectionchange", actions.selectionChanged);
  const change = () => document.dispatchEvent(event("selectionchange"));
  const down = ({
    inside = true,
    button = 0,
    consumed = false,
    isPrimary = true,
    target = inside ? element : document,
  }: {
    inside?: boolean;
    button?: number;
    consumed?: boolean;
    isPrimary?: boolean;
    target?: EventTarget;
  } = {}) => {
    const press = event("pointerdown", { button, isPrimary });
    Object.defineProperty(press, "target", { value: target });
    document.dispatchEvent(press);
    if (target === element && !consumed) element.dispatchEvent(press);
  };
  const focus = (target: EventTarget) => {
    document.activeElement = target;
    const focusEvent = event("focusin");
    Object.defineProperty(focusEvent, "target", { value: target });
    document.dispatchEvent(focusEvent);
  };
  const key = (key: string, target: EventTarget = document) => {
    const keyEvent = event("keydown", { key });
    Object.defineProperty(keyEvent, "target", { value: target });
    document.dispatchEvent(keyEvent);
  };
  const pointerUp = (button = 0) => {
    view.dispatchEvent(event("pointerup", { isPrimary: true, button }));
  };
  const up = ({ x = 300, y = 200, detail = 1, button = 0 } = {}) => {
    pointerUp(button);
    view.dispatchEvent(event("mouseup", { clientX: x, clientY: y, detail, button }));
  };
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const flush = (milliseconds = 0) => {
    vi.advanceTimersByTime(milliseconds);
    flushFrame();
  };
  return {
    actions,
    view,
    document,
    element,
    actionElement,
    field,
    onSelection,
    onDismiss,
    down,
    focus,
    key,
    up,
    pointerUp,
    change,
    flush,
    flushFrame,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("selection action gestures", () => {
  it("stays hidden through selection changes while dragging and uses the release point", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.change();
    surface.flush(1000);
    surface.change();
    surface.flush(1000);
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.up({ x: 420, y: 310 });
    surface.change();
    surface.flush();
    expect(surface.onSelection.mock.calls).toEqual([[{ x: 420, y: 310 }]]);
  });

  it("preserves the release anchor if the final selectionchange arrives after the menu opens", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up({ x: 180, y: 120 });
    surface.flush();
    surface.change();
    surface.flush();
    expect(surface.onSelection).toHaveBeenLastCalledWith({ x: 180, y: 120 });
  });

  it("lets a third click supersede the double-click popup before it opens", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up({ detail: 2 });
    surface.change();
    surface.flush(400);
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.down();
    surface.change();
    surface.flush(500);
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.up({ detail: 3, x: 310, y: 210 });
    surface.change();
    surface.flush(499);
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.flush(1);
    expect(surface.onSelection.mock.calls).toEqual([[{ x: 310, y: 210 }]]);
  });

  it("accepts release outside the surface but never a gesture that started outside", () => {
    const surface = createSelectionSurface();
    surface.down({ inside: false });
    surface.change();
    surface.up();
    surface.change();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.down();
    surface.up({ x: 1800, y: -10 });
    surface.flush();
    expect(surface.onSelection).toHaveBeenCalledWith({ x: 1800, y: -10 });
  });

  it("does not treat a consumed link or terminal mouse-reporting press as selection", () => {
    const surface = createSelectionSurface();
    surface.down({ consumed: true });
    surface.up();
    surface.change();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
  });

  it("ignores nonprimary pointers and non-left mouseup without ending a left drag", () => {
    const surface = createSelectionSurface();
    surface.down({ isPrimary: false });
    surface.up();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.down();
    surface.up({ button: 1 });
    surface.change();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.up();
    surface.flush();
    expect(surface.onSelection).toHaveBeenCalledOnce();
  });

  it("uses the text fallback after keyboard selection rather than a stale pointer", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up();
    surface.flush();
    surface.document.dispatchEvent(event("keydown", { key: "ArrowRight", shiftKey: true }));
    surface.change();
    surface.flush();
    expect(surface.onSelection).toHaveBeenLastCalledWith(null);
  });

  it("allows keyboard selection after a toolbar press suppresses compatibility mouseup", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up();
    surface.flush();
    surface.down({ inside: false });
    surface.pointerUp();
    surface.document.dispatchEvent(event("keydown", { key: "ArrowRight", shiftKey: true }));
    surface.change();
    surface.flush();
    expect(surface.onSelection).toHaveBeenLastCalledWith(null);
  });

  it("waits for mouseup's click count even if selectionchange lands after pointerup", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.pointerUp();
    surface.change();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.up({ detail: 2 });
    surface.flush(499);
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.flush(1);
    expect(surface.onSelection).toHaveBeenCalledOnce();
  });

  it.each(["Escape", "contextmenu", "pointercancel", "blur", "resize", "scroll"])(
    "%s dismisses pending actions and ignores a late selectionchange",
    (reason) => {
      const surface = createSelectionSurface();
      surface.down();
      surface.up({ detail: 2 });
      if (reason === "Escape") surface.document.dispatchEvent(event("keydown", { key: reason }));
      else if (reason === "contextmenu" || reason === "scroll")
        surface.element.dispatchEvent(event(reason));
      else surface.view.dispatchEvent(event(reason));
      surface.change();
      surface.flush(1000);
      expect(surface.onSelection).not.toHaveBeenCalled();
      surface.down();
      surface.up();
      surface.flush();
      expect(surface.onSelection).toHaveBeenCalledOnce();
    },
  );

  it("keeps an autoscrolling drag eligible to open on release", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.element.dispatchEvent(event("scroll"));
    surface.change();
    surface.flush(1000);
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.up();
    surface.flush();
    expect(surface.onSelection).toHaveBeenCalledOnce();
  });

  it("cancels a queued animation frame when a new press supersedes the release", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up();
    vi.advanceTimersByTime(0);
    expect(surface.actions.pending).toBe(true);
    surface.down();
    surface.flushFrame();
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.up();
    surface.flush();
    expect(surface.onSelection).toHaveBeenCalledOnce();
  });

  it("teardown cancels deferred work and detaches gesture listeners", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up();
    vi.advanceTimersByTime(0);
    surface.actions.dispose();
    surface.down();
    surface.up();
    surface.change();
    surface.flush(1000);
    expect(surface.onSelection).not.toHaveBeenCalled();
  });
});

describe("interactive selection actions", () => {
  it("keeps the captured selection while clicking, typing, and selecting in a comment field", () => {
    const surface = createSelectionSurface({ interactiveActions: true });
    surface.down();
    surface.up();
    surface.flush();
    surface.onDismiss.mockClear();
    surface.down({ target: surface.field });
    surface.focus(surface.field);
    surface.change();
    surface.up();
    surface.key("a", surface.field);
    surface.change();
    surface.key("ArrowLeft", surface.field);
    surface.change();
    surface.flush(1000);
    expect(surface.onDismiss).not.toHaveBeenCalled();
    expect(surface.onSelection).toHaveBeenCalledOnce();
  });

  it("cancels pending source reads when keyboard focus enters the actions", () => {
    const surface = createSelectionSurface({ interactiveActions: true });
    surface.key("Tab");
    surface.change();
    vi.advanceTimersByTime(0);
    expect(surface.actions.pending).toBe(true);
    surface.focus(surface.field);
    surface.change();
    surface.flushFrame();
    expect(surface.onSelection).not.toHaveBeenCalled();
    surface.focus(surface.actionElement);
    expect(surface.onDismiss).not.toHaveBeenCalled();
  });

  it.each(["outside press", "outside focus", "Escape", "scroll"])(
    "%s dismisses an interactive popover without recapturing its text",
    (reason) => {
      const surface = createSelectionSurface({ interactiveActions: true });
      surface.focus(surface.field);
      if (reason === "outside press") surface.down({ inside: false });
      else if (reason === "outside focus") surface.focus(surface.element);
      else if (reason === "Escape") surface.key("Escape", surface.field);
      else surface.element.dispatchEvent(event("scroll"));
      surface.change();
      surface.flush(1000);
      expect(surface.onDismiss).toHaveBeenCalledWith("cancel");
      expect(surface.onSelection).not.toHaveBeenCalled();
    },
  );

  it("allows a new source gesture to replace a comment selection", () => {
    const surface = createSelectionSurface({ interactiveActions: true });
    surface.focus(surface.field);
    surface.down();
    surface.focus(surface.element);
    surface.change();
    surface.flush();
    expect(surface.onSelection).not.toHaveBeenCalled();
    expect(surface.onDismiss).toHaveBeenCalledWith("interaction");
    surface.up({ x: 520, y: 320 });
    surface.flush();
    expect(surface.onSelection).toHaveBeenCalledWith({ x: 520, y: 320 });
  });
});

describe("selection action positioning", () => {
  const bounds = { left: 100, top: 50, width: 500, height: 220 };
  const viewport = { width: 1024, height: 768 };
  const selectionRect = { right: 260, bottom: 140 };

  it("prefers the cursor release over the selection's bounding box", () => {
    expect(
      resolveSelectionActionPosition({
        bounds,
        selectionRect,
        pointer: { x: 520, y: 200 },
        viewport,
      }),
    ).toEqual({ x: 520, y: 200 });
  });

  it("anchors keyboard selections just below the text end", () => {
    expect(
      resolveSelectionActionPosition({ bounds, selectionRect, pointer: null, viewport }),
    ).toEqual({ x: 260, y: 144 });
  });

  it.each([
    [
      { x: 720, y: 340 },
      { x: 600, y: 270 },
    ],
    [
      { x: 40, y: 20 },
      { x: 100, y: 50 },
    ],
  ])("keeps an outside release %j within the surface", (pointer, expected) => {
    expect(resolveSelectionActionPosition({ bounds, selectionRect, pointer, viewport })).toEqual(
      expected,
    );
  });

  it("keeps the anchor inside the browser even if the surface extends beyond it", () => {
    expect(
      resolveSelectionActionPosition({
        bounds: { left: -100, top: -100, width: 2000, height: 2000 },
        selectionRect,
        pointer: { x: 1800, y: -50 },
        viewport,
      }),
    ).toEqual({ x: 1016, y: 8 });
  });
});
