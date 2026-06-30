import { describe, expect, it, vi } from "vite-plus/test";
import {
  clearPendingTimelineAnchorScrollRestore,
  isTimelineScrollKeyboardNavigationKey,
  scheduleTimelineManualNavigationListeners,
} from "./useTimelineScrollController";

describe("timeline scroll controller", () => {
  it("recognizes keyboard keys that can move the timeline scroll position", () => {
    expect(isTimelineScrollKeyboardNavigationKey("ArrowUp")).toBe(true);
    expect(isTimelineScrollKeyboardNavigationKey("ArrowDown")).toBe(true);
    expect(isTimelineScrollKeyboardNavigationKey("PageUp")).toBe(true);
    expect(isTimelineScrollKeyboardNavigationKey("PageDown")).toBe(true);
    expect(isTimelineScrollKeyboardNavigationKey("Home")).toBe(true);
    expect(isTimelineScrollKeyboardNavigationKey("End")).toBe(true);
    expect(isTimelineScrollKeyboardNavigationKey(" ")).toBe(true);
  });

  it("ignores non-navigation keys", () => {
    expect(isTimelineScrollKeyboardNavigationKey("Enter")).toBe(false);
    expect(isTimelineScrollKeyboardNavigationKey("Escape")).toBe(false);
    expect(isTimelineScrollKeyboardNavigationKey("a")).toBe(false);
  });

  it("retries manual navigation listener setup when the scroll node mounts late", () => {
    const frames: FrameRequestCallback[] = [];
    const listeners = new Map<string, Set<EventListener>>();
    const onManualNavigation = vi.fn();
    let scrollNode: HTMLElement | null = null;

    const node = {
      addEventListener: (type: string, listener: EventListener) => {
        const typeListeners = listeners.get(type) ?? new Set<EventListener>();
        typeListeners.add(listener);
        listeners.set(type, typeListeners);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
    } as HTMLElement;

    const cleanup = scheduleTimelineManualNavigationListeners({
      getScrollNode: () => scrollNode,
      maxAttempts: 2,
      onManualNavigation,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => {},
    });

    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(listeners.get("wheel")).toBeUndefined();
    expect(frames).toHaveLength(1);

    scrollNode = node;
    frames.shift()?.(0);
    expect(listeners.get("wheel")?.size).toBe(1);
    expect(listeners.get("touchmove")?.size).toBe(1);
    expect(listeners.get("pointerdown")?.size).toBe(1);
    expect(listeners.get("keydown")?.size).toBe(1);

    listeners.get("wheel")?.forEach((listener) => listener({} as Event));
    expect(onManualNavigation).toHaveBeenCalledOnce();

    cleanup();
    expect(listeners.get("wheel")?.size).toBe(0);
    expect(listeners.get("touchmove")?.size).toBe(0);
    expect(listeners.get("pointerdown")?.size).toBe(0);
    expect(listeners.get("keydown")?.size).toBe(0);
  });

  it("clears pending anchor scroll restore state and cancels the queued frame", () => {
    const pendingAnchorScrollRestoreRef = {
      current: {
        messageId: "message-1",
        offset: 42,
        userScrollGeneration: 1,
      },
    };
    const anchorScrollRestoreFrameRef = { current: 7 };
    const cancelFrame = vi.fn();

    clearPendingTimelineAnchorScrollRestore({
      anchorScrollRestoreFrameRef,
      cancelFrame,
      pendingAnchorScrollRestoreRef,
    });

    expect(pendingAnchorScrollRestoreRef.current).toBeNull();
    expect(anchorScrollRestoreFrameRef.current).toBeNull();
    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
