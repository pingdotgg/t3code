import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { longPressContextMenuProps } from "./longPressContextMenu";

class FakeMouseEvent {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown> = {},
  ) {}

  preventDefault() {}
  stopPropagation() {}
}

class FakeElement {
  readonly dispatched: FakeMouseEvent[] = [];

  constructor(private readonly matchedSelector: string | null = null) {}

  closest(selector: string) {
    if (this.matchedSelector === null) return null;
    return selector.includes(this.matchedSelector) ? this : null;
  }

  dispatchEvent(event: FakeMouseEvent) {
    this.dispatched.push(event);
    return true;
  }
}

type DocumentListener = () => void;

let timers: Map<number, () => void>;
let nextTimerId: number;
let documentListeners: Map<string, DocumentListener[]>;

function runPendingTimers() {
  const callbacks = [...timers.values()];
  timers.clear();
  for (const callback of callbacks) callback();
}

function dispatchOnDocument(type: string) {
  for (const listener of documentListeners.get(type) ?? []) listener();
}

function pointerEvent(target: FakeElement, overrides: Record<string, unknown> = {}) {
  return {
    clientX: 10,
    clientY: 20,
    currentTarget: target,
    pointerType: "touch",
    target: null,
    ...overrides,
  } as unknown as ReactPointerEvent;
}

beforeEach(() => {
  timers = new Map();
  nextTimerId = 1;
  documentListeners = new Map();

  vi.stubGlobal("window", {
    clearTimeout: (id: number) => timers.delete(id),
    setTimeout: (callback: () => void) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
  });
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: DocumentListener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: DocumentListener) => {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("MouseEvent", FakeMouseEvent);
});

afterEach(() => {
  longPressContextMenuProps.onPointerCancel();
  vi.unstubAllGlobals();
});

describe("longPressContextMenuProps", () => {
  it("opens a context menu at the press position after a long touch", () => {
    const target = new FakeElement();

    longPressContextMenuProps.onPointerDown(pointerEvent(target));
    runPendingTimers();

    expect(target.dispatched).toHaveLength(1);
    expect(target.dispatched[0]?.type).toBe("contextmenu");
    expect(target.dispatched[0]?.init).toMatchObject({
      bubbles: true,
      clientX: 10,
      clientY: 20,
    });
  });

  it.each(["mouse", "pen"])("leaves %s input to the native context menu", (pointerType) => {
    const target = new FakeElement();

    longPressContextMenuProps.onPointerDown(pointerEvent(target, { pointerType }));
    runPendingTimers();

    expect(target.dispatched).toHaveLength(0);
  });

  it("leaves long presses inside a text field alone", () => {
    const target = new FakeElement();

    longPressContextMenuProps.onPointerDown(
      pointerEvent(target, { target: new FakeElement("input") }),
    );
    runPendingTimers();

    expect(target.dispatched).toHaveLength(0);
  });

  it("survives small finger movement", () => {
    const target = new FakeElement();

    longPressContextMenuProps.onPointerDown(pointerEvent(target));
    longPressContextMenuProps.onPointerMove(pointerEvent(target, { clientX: 14, clientY: 24 }));
    runPendingTimers();

    expect(target.dispatched).toHaveLength(1);
  });

  it("cancels once the finger moves past the tolerance", () => {
    const target = new FakeElement();

    longPressContextMenuProps.onPointerDown(pointerEvent(target));
    longPressContextMenuProps.onPointerMove(pointerEvent(target, { clientX: 40 }));
    runPendingTimers();

    expect(target.dispatched).toHaveLength(0);
  });

  it("cancels when the browser fires its own context menu", () => {
    const target = new FakeElement();

    longPressContextMenuProps.onPointerDown(pointerEvent(target));
    dispatchOnDocument("contextmenu");
    runPendingTimers();

    expect(target.dispatched).toHaveLength(0);
  });
});
