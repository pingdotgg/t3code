import { type MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  clearTimelineAnchorIfPositioningExhausted,
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
    const onExhausted = vi.fn();
    const onInstalled = vi.fn();
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
      onExhausted,
      onInstalled,
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
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(onExhausted).not.toHaveBeenCalled();
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

  it("reports exhausted manual navigation listener setup without installing listeners", () => {
    const frames: FrameRequestCallback[] = [];
    const onExhausted = vi.fn();
    const onInstalled = vi.fn();

    scheduleTimelineManualNavigationListeners({
      getScrollNode: () => null,
      maxAttempts: 1,
      onExhausted,
      onInstalled,
      onManualNavigation: vi.fn(),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => {},
    });

    frames.shift()?.(0);
    expect(onExhausted).not.toHaveBeenCalled();
    frames.shift()?.(0);
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(onInstalled).not.toHaveBeenCalled();
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

  it("clears exhausted anchor positioning only for the active positioned anchor", () => {
    const message1 = "message-1" as MessageId;
    const message2 = "message-2" as MessageId;
    const activeTimelineAnchorIndexRef = { current: 3 };
    const positionedTimelineAnchorRef = { current: message1 };
    const settledTimelineAnchorRef = { current: message1 };
    const timelineScrollModeRef = { current: "anchoring-new-turn" as const };

    clearTimelineAnchorIfPositioningExhausted({
      activeTimelineAnchorIndexRef,
      messageId: message2,
      positionedTimelineAnchorRef,
      settledTimelineAnchorRef,
      timelineScrollModeRef,
    });

    expect(activeTimelineAnchorIndexRef.current).toBe(3);
    expect(positionedTimelineAnchorRef.current).toBe(message1);
    expect(settledTimelineAnchorRef.current).toBe(message1);
    expect(timelineScrollModeRef.current).toBe("anchoring-new-turn");

    clearTimelineAnchorIfPositioningExhausted({
      activeTimelineAnchorIndexRef,
      messageId: message1,
      positionedTimelineAnchorRef,
      settledTimelineAnchorRef,
      timelineScrollModeRef,
    });

    expect(activeTimelineAnchorIndexRef.current).toBeNull();
    expect(positionedTimelineAnchorRef.current).toBeNull();
    expect(settledTimelineAnchorRef.current).toBeNull();
    expect(timelineScrollModeRef.current).toBe("following-end");
  });
});
