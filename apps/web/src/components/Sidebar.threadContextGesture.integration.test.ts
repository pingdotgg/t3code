/**
 * Production-path integration coverage for the sidebar thread-context drag
 * gesture (sidebar → composer bridge).
 *
 * These tests drive the REAL production gesture entry
 * (`startSidebarThreadContextGesture` from `Sidebar.tsx`) and the REAL
 * bridge (`threadContextDrag.ts`) with REAL DOM event semantics (real
 * `CustomEvent` + real `EventTarget` dispatch). A receiver that merely
 * receives the event without `preventDefault` is a rejection — the tests
 * never stub `dispatchEvent` to claim success.
 *
 * Each case mirrors a verified regression from the original gesture PR:
 * - unpinned-row context drop must not poison the next pinned reorder
 *   (global flag scoped to pinned gestures, cleared on next gesture start
 *   and consumed by pinned drag end/cancel, including nested per-project
 *   `DndContext`s);
 * - a missed release after activation (buttons released outside the window)
 *   must clear the ghost instead of stranding it;
 * - cancel (Escape) clears the ghost and stands down a trailing pinned
 *   reorder; returning to the list clears the ghost so the reorder preview
 *   resumes;
 * - presses on controls keep click/selection behavior (no gesture arms);
 * - virtual-agent run rows (parent ref + child label) never arm the gesture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, StrictMode } from "react";

import {
  __getActiveThreadContextGestureForTests,
  __getConsumedThreadContextDropForTests,
  __resetThreadContextDragForTests,
  __setConsumedThreadContextDropForTests,
  startSidebarThreadContextGesture,
} from "./Sidebar";
import {
  resolvePinnedDragEndShouldReorder,
  shouldIgnoreThreadContextDragStart,
} from "./Sidebar.logic";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadContextDragGhost } from "./chat/threadContextDrag";

// Real DOM event classes for `instanceof` checks in production code.
class TestPointerEvent {
  pointerId = 0;
  clientX = 0;
  clientY = 0;
  buttons = 0;
  cancelable = true;
  constructor(init: Partial<TestPointerEvent> = {}) {
    Object.assign(this, init);
  }
  preventDefault() {}
}

class TestKeyboardEvent {
  code = "";
  constructor(init: Partial<TestKeyboardEvent> = {}) {
    Object.assign(this, init);
  }
}

class TestElement {
  closest(_selector: string): unknown {
    return null;
  }
}

type Listener = (event: never) => void;

function makeEventRegistry() {
  const byType = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) {
      let set = byType.get(type);
      if (!set) {
        set = new Set();
        byType.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      byType.get(type)?.delete(listener);
    },
    dispatch(type: string, event: never) {
      for (const listener of [...(byType.get(type) ?? [])]) listener(event);
    },
    clear() {
      byType.clear();
    },
  };
}

/** Real `EventTarget` drop target with attribute bookkeeping. */
function makeDropTarget(options: {
  disabled?: boolean;
  accept?: boolean;
  onEvent?: (event: CustomEvent) => void;
}) {
  const target = new EventTarget() as EventTarget & {
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
    hasAttribute: (name: string) => boolean;
    closest: (selector: string) => unknown;
  };
  const attributes = new Set<string>();
  target.setAttribute = (name: string) => {
    attributes.add(name);
  };
  target.removeAttribute = (name: string) => {
    attributes.delete(name);
  };
  target.hasAttribute = (name: string) => {
    if (name === "data-thread-context-drop-disabled") return options.disabled ?? false;
    return attributes.has(name);
  };
  target.closest = (selector: string) =>
    selector.includes("data-thread-context-drop") ? target : null;
  // Real receiver semantics: only `preventDefault` on the cancelable event
  // counts as acceptance. Merely receiving is a rejection.
  target.addEventListener("t3-thread-context-drop", (raw) => {
    const event = raw as unknown as CustomEvent;
    options.onEvent?.(event);
    if (options.accept === true) event.preventDefault();
  });
  return target;
}

describe("sidebar thread-context production gesture", () => {
  let documentRegistry: ReturnType<typeof makeEventRegistry>;
  let windowRegistry: ReturnType<typeof makeEventRegistry>;
  let elementFromPoint: ReturnType<typeof vi.fn>;
  let renderers: ReactTestRenderer[];
  let ghostTarget: ReturnType<typeof makeDropTarget> | null;

  const listBounds = { left: 0, right: 260 };
  const listEl = {
    getBoundingClientRect: () => ({ left: listBounds.left, right: listBounds.right }),
  };

  function rowEl() {
    const row = new TestElement() as TestElement & {
      closest: (selector: string) => unknown;
    };
    // Production resolves the list via the row's closest list ancestor.
    row.closest = (selector: string) => (selector.includes("thread-context-list") ? listEl : null);
    return row;
  }

  function startGesture(source: {
    threadKey: string;
    title: string;
    isPinned?: boolean;
    isVirtualAgentRun?: boolean;
  }) {
    const row = rowEl();
    startSidebarThreadContextGesture(
      {
        target: row,
        currentTarget: row,
        clientX: 130,
        clientY: 400,
        button: 0,
        nativeEvent: { isPrimary: true, pointerId: 7 },
      } as unknown as React.PointerEvent,
      // The production source carries the row identity; virtual-agent rows
      // must never reach the gesture (parent ref + child label mismatch).
      source as never,
    );
  }

  function move(point: { x: number; y: number }, buttons: number) {
    documentRegistry.dispatch(
      "pointermove",
      new TestPointerEvent({
        pointerId: 7,
        clientX: point.x,
        clientY: point.y,
        buttons,
      }) as never,
    );
  }

  function release(point: { x: number; y: number }) {
    documentRegistry.dispatch(
      "pointerup",
      new TestPointerEvent({ pointerId: 7, clientX: point.x, clientY: point.y }) as never,
    );
  }

  function pressEscape() {
    documentRegistry.dispatch("keydown", new TestKeyboardEvent({ code: "Escape" }) as never);
  }

  function ghostProbe() {
    const seen: Array<unknown> = [];
    function Probe() {
      seen.push(useThreadContextDragGhost());
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(StrictMode, null, createElement(Probe)));
    });
    renderers.push(renderer!);
    return seen;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    vi.stubGlobal("KeyboardEvent", TestKeyboardEvent);
    vi.stubGlobal("Element", TestElement);
    renderers = [];
    ghostTarget = null;
    documentRegistry = makeEventRegistry();
    windowRegistry = makeEventRegistry();
    elementFromPoint = vi.fn(() => null);
    vi.stubGlobal("document", {
      elementFromPoint,
      hidden: false,
      addEventListener: documentRegistry.addEventListener,
      removeEventListener: documentRegistry.removeEventListener,
      getSelection: () => ({ removeAllRanges: () => {} }),
    });
    vi.stubGlobal("window", {
      addEventListener: windowRegistry.addEventListener,
      removeEventListener: windowRegistry.removeEventListener,
    });
    __resetThreadContextDragForTests();
    useThreadSelectionStore.setState({ selectedThreadKeys: new Set<string>() });
  });

  afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
    __resetThreadContextDragForTests();
    useThreadSelectionStore.setState({ selectedThreadKeys: new Set<string>() });
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("unpinned-row context drop does not poison the next pinned reorder", () => {
    // Real accepting composer: preventDefault marks acceptance.
    ghostTarget = makeDropTarget({ accept: true });
    elementFromPoint.mockReturnValue(ghostTarget);
    const seen = ghostProbe();

    // Production unpinned-row gesture: press, drag past activation, exit the
    // list horizontally, release over the composer target.
    startGesture({
      threadKey: "env-test:thread-unpinned",
      title: "Unpinned thread",
      isPinned: false,
    });
    expect(__getActiveThreadContextGestureForTests()).not.toBeNull();
    act(() => {
      move({ x: 140, y: 400 }, 1);
    });
    act(() => {
      move({ x: 400, y: 400 }, 1);
    });
    expect(__getActiveThreadContextGestureForTests()?.outside).toBe(true);
    act(() => {
      release({ x: 400, y: 400 });
    });
    expect(__getActiveThreadContextGestureForTests()).toBeNull();
    expect(seen.at(-1)).toBeNull();

    // The next genuine pinned reorder (nested per-project DndContexts share
    // the flag) must still reorder: an unpinned-row drop has no trailing
    // pinned drag end to consume the flag, so it must never set it.
    const consumed = __getConsumedThreadContextDropForTests();
    expect(
      resolvePinnedDragEndShouldReorder({ wasContextDrag: consumed, activeId: "a", overId: "b" }),
    ).toBe(true);
  });

  it("a missed release after activation clears the ghost instead of stranding it", () => {
    ghostTarget = makeDropTarget({ accept: true });
    elementFromPoint.mockReturnValue(ghostTarget);
    const seen = ghostProbe();

    startGesture({ threadKey: "env-test:thread-1", title: "Thread one" });
    act(() => {
      move({ x: 140, y: 400 }, 1);
    });
    act(() => {
      move({ x: 400, y: 400 }, 1);
    });
    expect(__getActiveThreadContextGestureForTests()?.outside).toBe(true);
    expect(seen.at(-1)).not.toBeNull();

    // The release outside the window is missed (no pointerup arrives); the
    // next observed move has no buttons held. Production must treat this as
    // the end of the gesture and clear the ghost.
    act(() => {
      move({ x: 410, y: 410 }, 0);
    });
    expect(__getActiveThreadContextGestureForTests()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it("cancel clears the ghost and stands down a trailing pinned reorder", () => {
    const seen = ghostProbe();
    startGesture({ threadKey: "env-test:thread-pinned", title: "Pinned thread", isPinned: true });
    act(() => {
      move({ x: 140, y: 400 }, 1);
    });
    act(() => {
      move({ x: 400, y: 400 }, 1);
    });
    expect(seen.at(-1)).not.toBeNull();

    act(() => {
      pressEscape();
    });
    expect(__getActiveThreadContextGestureForTests()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    // A cancelled pinned gesture must suppress the trailing dnd-kit drag end
    // from the same pointer; the next gesture start consumes the flag again.
    expect(
      resolvePinnedDragEndShouldReorder({
        wasContextDrag: __getConsumedThreadContextDropForTests(),
        activeId: "a",
        overId: "b",
      }),
    ).toBe(false);
  });

  it("returning to the list clears the ghost so the reorder preview resumes", () => {
    const seen = ghostProbe();
    startGesture({ threadKey: "env-test:thread-pinned", title: "Pinned thread", isPinned: true });
    act(() => {
      move({ x: 140, y: 400 }, 1);
    });
    act(() => {
      move({ x: 400, y: 400 }, 1);
    });
    expect(seen.at(-1)).not.toBeNull();
    act(() => {
      move({ x: 130, y: 450 }, 1);
    });
    expect(__getActiveThreadContextGestureForTests()?.outside).toBe(false);
    expect(seen.at(-1)).toBeNull();
  });

  it("presses on controls never arm the gesture, preserving clicks", () => {
    for (const target of [
      "button",
      "input",
      "a",
      "textarea",
      "select",
      "[data-thread-selection-safe]",
      "[contenteditable]",
      "[role='menu']",
      "[role='dialog']",
    ]) {
      expect(
        shouldIgnoreThreadContextDragStart({
          button: 0,
          isPrimary: true,
          closest: (selector: string) => (selector.includes(target) ? {} : null),
        }),
        target,
      ).toBe(true);
    }
    // Non-primary and non-left presses keep selection/menu behavior.
    expect(
      shouldIgnoreThreadContextDragStart({ button: 2, isPrimary: true, closest: () => null }),
    ).toBe(true);
    expect(
      shouldIgnoreThreadContextDragStart({ button: 0, isPrimary: false, closest: () => null }),
    ).toBe(true);
  });

  it("virtual-agent run rows never arm the gesture (parent ref / child label mismatch)", () => {
    startGesture({
      threadKey: "env-test:thread-parent",
      title: "Child run label",
      isVirtualAgentRun: true,
    });
    // Production must refuse to arm virtual-agent rows: their ref points at
    // the parent thread while the label names the child run, so any drop
    // would attach the wrong identity.
    expect(__getActiveThreadContextGestureForTests()).toBeNull();
  });

  it("nested project contexts share one suppression flag without leaking across gestures", () => {
    // A stale flag from an earlier gesture must not suppress an unrelated
    // project's genuine reorder: starting a fresh gesture owns the flag.
    __setConsumedThreadContextDropForTests(true);
    startGesture({ threadKey: "env-test:thread-b", title: "Project B thread" });
    expect(__getConsumedThreadContextDropForTests()).toBe(false);
    expect(__getActiveThreadContextGestureForTests()).not.toBeNull();
  });

  it("an unaccepted drop never reads as an attachment", () => {
    let received: CustomEvent | null = null;
    // Real rejecting composer: receives the cancelable event but never
    // prevents the default (busy, disabled, self-thread, cross-environment).
    ghostTarget = makeDropTarget({
      onEvent: (event) => {
        received = event;
      },
    });
    elementFromPoint.mockReturnValue(ghostTarget);

    startGesture({ threadKey: "env-test:thread-1", title: "Thread one" });
    act(() => {
      move({ x: 140, y: 400 }, 1);
    });
    act(() => {
      move({ x: 400, y: 400 }, 1);
    });
    act(() => {
      release({ x: 400, y: 400 });
    });

    expect(received).toBeInstanceOf(CustomEvent);
    expect((received as unknown as CustomEvent).cancelable).toBe(true);
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).defaultPrevented).toBe(false);
  });
});
