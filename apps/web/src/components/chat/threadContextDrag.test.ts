import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, StrictMode } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  THREAD_CONTEXT_DROP_EVENT,
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
  threadContextDropTargetProps,
  useThreadContextDragGhost,
} from "./threadContextDrag";

const threadRef = (threadId: string): ScopedThreadRef =>
  // ScopedThreadRef is a plain `{ environmentId, threadId }` identity; the
  // bridge never constructs it, it only carries refs supplied by the sidebar.
  ({ environmentId: "environment-local", threadId }) as ScopedThreadRef;

function fakeTarget(options: { disabled?: boolean; onDispatch?: (event: Event) => void } = {}) {
  const attributes = new Set<string>();
  return {
    setAttribute: vi.fn((name: string) => {
      attributes.add(name);
    }),
    removeAttribute: vi.fn((name: string) => {
      attributes.delete(name);
    }),
    hasAttribute: (name: string) =>
      name === "data-thread-context-drop-disabled"
        ? (options.disabled ?? false)
        : attributes.has(name),
    dispatchEvent: vi.fn((event: Event) => {
      options.onDispatch?.(event);
      // Mirror DOM dispatch semantics for a cancelable event: false when the
      // receiver accepted via preventDefault, true otherwise.
      if (event instanceof CustomEvent && event.cancelable && event.defaultPrevented) return false;
      return true;
    }),
    // `closest` is called on the element returned by elementFromPoint.
    closest: vi.fn(() => null),
  };
}

describe("threadContextDrag bridge", () => {
  let elementFromPoint: ReturnType<typeof vi.fn>;
  let renderers: ReactTestRenderer[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    renderers = [];
    elementFromPoint = vi.fn(() => null);
    vi.stubGlobal("document", { elementFromPoint });
    endThreadContextDrag();
  });

  afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
    endThreadContextDrag();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function ghostProbe() {
    const seen: Array<{ x: number; y: number; title: string; count: number } | null> = [];
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

  it("exposes the composer drop contract on the composer form", () => {
    expect(THREAD_CONTEXT_DROP_EVENT).toBe("t3-thread-context-drop");
    expect(threadContextDropTargetProps()).toEqual({ "data-thread-context-drop": "true" });
  });

  it("moves the ghost without touching sidebar state and clears it on end", () => {
    const seen = ghostProbe();
    const target = fakeTarget();
    // The ghost element itself is found through the drop target so the
    // highlight and the ghost position stay in lockstep.
    (target.closest as ReturnType<typeof vi.fn>).mockReturnValue(target);
    elementFromPoint.mockReturnValue({ closest: () => target });

    act(() => {
      moveThreadContextDrag({ x: 400, y: 200 }, { title: "Thread title", count: 1 });
    });
    expect(seen.at(-1)).toEqual({ x: 400, y: 200, title: "Thread title", count: 1 });
    expect(target.setAttribute).toHaveBeenCalledWith("data-thread-context-over", "true");

    act(() => {
      moveThreadContextDrag({ x: 410, y: 210 }, { title: "Thread title", count: 3 });
    });
    expect(seen.at(-1)).toEqual({ x: 410, y: 210, title: "Thread title", count: 3 });

    act(() => {
      endThreadContextDrag();
    });
    expect(seen.at(-1)).toBeNull();
    expect(target.removeAttribute).toHaveBeenCalledWith("data-thread-context-over");
  });

  it("reports no drop when the pointer is not over a composer target", () => {
    elementFromPoint.mockReturnValue(null);
    expect(dropThreadContext({ x: 10, y: 10 }, [threadRef("thread-1")])).toBe(false);
  });

  it("never dispatches for an empty ref list", () => {
    const target = fakeTarget();
    elementFromPoint.mockReturnValue({ closest: () => target });
    expect(dropThreadContext({ x: 400, y: 200 }, [])).toBe(false);
    expect(target.dispatchEvent).not.toHaveBeenCalled();
  });

  it("stays disabled until the composer opts in via capability gating", () => {
    const target = fakeTarget();
    elementFromPoint.mockReturnValue({ closest: () => target });
    expect(dropThreadContext({ x: 400, y: 200 }, [threadRef("thread-1")], { enabled: false })).toBe(
      false,
    );
    expect(target.dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not dispatch to a target that marks itself disabled", () => {
    const target = fakeTarget({ disabled: true });
    elementFromPoint.mockReturnValue({ closest: () => target });
    expect(dropThreadContext({ x: 400, y: 200 }, [threadRef("thread-1")])).toBe(false);
    expect(target.dispatchEvent).not.toHaveBeenCalled();
  });

  it("finding a target is not success: an unaccepted drop reports false", () => {
    let received: Event | null = null;
    const target = fakeTarget({
      onDispatch: (event) => {
        received = event;
      },
    });
    elementFromPoint.mockReturnValue({ closest: () => target });

    // The receiver rejects (busy, disabled, self-thread, cross-environment)
    // by simply not calling preventDefault.
    expect(dropThreadContext({ x: 400, y: 200 }, [threadRef("thread-1")])).toBe(false);

    expect(target.dispatchEvent).toHaveBeenCalledOnce();
    expect(received).toBeInstanceOf(CustomEvent);
    const detail = (received as unknown as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail;
    expect([...detail]).toEqual([threadRef("thread-1")]);
  });

  it("reports true only when the composer accepts the drop", () => {
    const target = fakeTarget({
      onDispatch: (event) => {
        // A later composer integration accepts by preventing the default on
        // the cancelable drop event after its own self/cross-env/busy checks.
        event.preventDefault();
      },
    });
    elementFromPoint.mockReturnValue({ closest: () => target });
    expect(dropThreadContext({ x: 400, y: 200 }, [threadRef("thread-1")])).toBe(true);
  });

  it("does not claim end-to-end attachment when the receiver is mocked out", () => {
    // Regression guard for the acceptance rule: a stubbed dispatch that never
    // preventDefaults must never read as an attachment, even though a target
    // was found and an event was delivered.
    const target = fakeTarget();
    elementFromPoint.mockReturnValue({ closest: () => target });
    const accepted = dropThreadContext({ x: 400, y: 200 }, [threadRef("thread-1")]);
    expect(target.dispatchEvent).toHaveBeenCalledOnce();
    expect(accepted).toBe(false);
  });
});
