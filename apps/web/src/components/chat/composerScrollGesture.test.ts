// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import {
  createComposerScrollGestureState,
  listenForComposerScrollGestures,
  recordComposerScrollGestureEvent,
  resetComposerScrollGesture,
  shouldCollapseComposerForScrollKey,
  suppressActiveComposerScrollGesture,
} from "./composerScrollGesture";

const RESET_MS = 120;
const THRESHOLD_PX = 24;

describe("composer keyboard scroll collapse", () => {
  const middle = {
    scrollTop: 500,
    scrollHeight: 1500,
    clientHeight: 500,
    isAtLogicalEnd: false,
  };

  it.each(["PageUp", "PageDown", "Home", "End"])("collapses on %s in the timeline", (key) => {
    expect(shouldCollapseComposerForScrollKey({ ...middle, key })).toBe(true);
  });

  it.each(["PageUp", "Home"])("does not collapse on %s at the top", (key) => {
    expect(shouldCollapseComposerForScrollKey({ ...middle, key, scrollTop: 0 })).toBe(false);
  });

  it.each(["PageDown", "End"])("does not collapse on %s at the logical end", (key) => {
    expect(shouldCollapseComposerForScrollKey({ ...middle, key, isAtLogicalEnd: true })).toBe(
      false,
    );
    expect(shouldCollapseComposerForScrollKey({ ...middle, key, scrollTop: 1000 })).toBe(false);
  });

  it("ignores unrelated keys", () => {
    expect(shouldCollapseComposerForScrollKey({ ...middle, key: "Enter" })).toBe(false);
  });
});

function record(
  state: ReturnType<typeof createComposerScrollGestureState>,
  now: number,
  options: Partial<{
    deltaPx: number;
    collapseEligible: boolean;
    canScrollInGestureDirection: boolean;
    scrollsTowardLogicalEnd: boolean;
  }> = {},
) {
  return recordComposerScrollGestureEvent(state, {
    now,
    deltaPx: options.deltaPx ?? 30,
    collapseThresholdPx: THRESHOLD_PX,
    collapseEligible: options.collapseEligible ?? true,
    canScrollInGestureDirection: options.canScrollInGestureDirection ?? true,
    scrollsTowardLogicalEnd: options.scrollsTowardLogicalEnd ?? false,
  });
}

describe("composer scroll gesture", () => {
  it("lets an editor change win over the rest of the active gesture", () => {
    const state = createComposerScrollGestureState();

    expect(record(state, 0)).toBe(true);
    suppressActiveComposerScrollGesture(state, 20, RESET_MS);

    expect(record(state, 40)).toBe(false);
    expect(record(state, 80)).toBe(false);
    expect(record(state, 160)).toBe(false);
  });

  it("preserves suppression while collapse is temporarily ineligible", () => {
    const state = createComposerScrollGestureState();

    record(state, 0);
    suppressActiveComposerScrollGesture(state, 20, RESET_MS);

    expect(record(state, 40, { collapseEligible: false })).toBe(false);
    expect(record(state, 80, { collapseEligible: true })).toBe(false);
  });

  it("keeps a boundary momentum tail in the same suppressed gesture", () => {
    const state = createComposerScrollGestureState();

    record(state, 0);
    suppressActiveComposerScrollGesture(state, 20, RESET_MS);

    expect(record(state, 80, { canScrollInGestureDirection: false })).toBe(false);
    expect(state.lastEventAt).toBe(80);
    expect(record(state, 160)).toBe(false);
  });

  it("does not carry gesture state into a new thread after reset", () => {
    const state = createComposerScrollGestureState();

    record(state, 0);
    suppressActiveComposerScrollGesture(state, 20, RESET_MS);
    record(state, 80);
    resetComposerScrollGesture(state);

    expect(record(state, 240)).toBe(true);
  });

  it("accumulates small deltas only while collapse remains eligible and scrollable", () => {
    const state = createComposerScrollGestureState();

    expect(record(state, 0, { deltaPx: 10 })).toBe(false);
    expect(record(state, 20, { deltaPx: 10 })).toBe(false);
    expect(record(state, 40, { deltaPx: 4 })).toBe(true);
    expect(record(state, 60, { deltaPx: 10, collapseEligible: false })).toBe(false);
    expect(record(state, 80, { deltaPx: 14 })).toBe(false);
  });

  it("does not collapse while scrolling down through composer footer space", () => {
    const state = createComposerScrollGestureState();

    expect(record(state, 0, { deltaPx: 20 })).toBe(false);
    expect(record(state, 20, { scrollsTowardLogicalEnd: true })).toBe(false);
    expect(record(state, 40, { deltaPx: 10 })).toBe(false);
  });
});

describe("composer timeline scroll input", () => {
  let timeline: HTMLDivElement;
  let content: HTMLDivElement;
  let collapsed: boolean;
  let atLogicalEnd: boolean;
  let dispose: () => void;

  function pointerDown(target: EventTarget, button = 0) {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button }));
  }

  function pointerUp(button = 0) {
    window.dispatchEvent(new MouseEvent("pointerup", { button }));
  }

  function scrollTo(scrollTop: number) {
    timeline.scrollTop = scrollTop;
    timeline.dispatchEvent(new Event("scroll"));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    timeline = document.createElement("div");
    content = document.createElement("div");
    timeline.append(content);
    document.body.append(timeline);
    Object.defineProperties(timeline, {
      scrollHeight: { value: 1500 },
      clientHeight: { value: 500 },
    });
    timeline.scrollTop = 500;
    collapsed = false;
    atLogicalEnd = false;
    dispose = listenForComposerScrollGestures({
      gestureState: createComposerScrollGestureState(),
      getTimelineScrollableNode: () => timeline,
      isTimelineAtLogicalEnd: (scrollOffset) =>
        atLogicalEnd ||
        resolveTimelineIsAtEnd(
          { isAtEnd: false, contentLength: 1500, scroll: 500, scrollLength: 500 },
          scrollOffset,
        ) === true,
      isCollapseEligible: () => !collapsed,
      onCollapse: () => {
        collapsed = true;
      },
      restoreAfterTimelineReachedEnd: () => {
        collapsed = false;
      },
    });
  });

  afterEach(() => {
    dispose();
    timeline.remove();
    vi.useRealTimers();
  });

  it.each(["scrollbar", "touch", "middle click"])(
    "collapses after enough %s movement and restores at the logical end",
    (input) => {
      scrollTo(600);
      expect(collapsed).toBe(false);

      if (input === "scrollbar") pointerDown(timeline);
      if (input === "touch") content.dispatchEvent(new Event("touchmove", { bubbles: true }));
      if (input === "middle click") {
        pointerDown(content, 1);
        pointerUp(1);
      }

      scrollTo(590);
      scrollTo(580);
      expect(collapsed).toBe(false);
      scrollTo(576);
      expect(collapsed).toBe(true);
      if (input === "middle click") vi.advanceTimersByTime(1000);

      // The last message can be visible before the footer's physical bottom.
      atLogicalEnd = true;
      scrollTo(700);
      expect(collapsed).toBe(false);
      scrollTo(730);
      expect(collapsed).toBe(false);
    },
  );

  it("restores in the logical end band before the list records the new offset", () => {
    scrollTo(900);
    pointerDown(timeline);
    scrollTo(950);
    expect(collapsed).toBe(true);

    scrollTo(960);
    expect(collapsed).toBe(false);
    scrollTo(985);
    expect(collapsed).toBe(false);
  });

  it("does not track middle-clicks on links as timeline scrolling", () => {
    const link = document.createElement("a");
    link.href = "https://example.com";
    const label = document.createElement("span");
    link.append(label);
    content.append(link);

    pointerDown(label, 1);
    pointerUp(1);
    scrollTo(550);
    expect(collapsed).toBe(false);
  });

  it("ends the release tail even when scrolls and duplicate releases keep arriving", () => {
    content.dispatchEvent(new Event("touchmove", { bubbles: true }));
    scrollTo(490);
    window.dispatchEvent(new Event("touchend"));
    vi.advanceTimersByTime(100);
    scrollTo(476);
    expect(collapsed).toBe(true);

    atLogicalEnd = true;
    scrollTo(700);
    expect(collapsed).toBe(false);
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("pointerup"));
    scrollTo(710);
    vi.advanceTimersByTime(51);

    // A new streaming turn can move the logical end while follow scrolls continue.
    atLogicalEnd = false;
    scrollTo(750);
    vi.advanceTimersByTime(100);
    scrollTo(800);
    expect(collapsed).toBe(false);
  });

  it("does not turn a press and release without scrolling into a live-follow gesture", () => {
    pointerDown(timeline);
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(10);
    scrollTo(550);
    expect(collapsed).toBe(false);
  });

  it.each(["pointercancel", "touchcancel", "blur"])(
    "does not collapse on live-follow scrolling after %s interrupts the gesture",
    (event) => {
      if (event === "touchcancel") {
        content.dispatchEvent(new Event("touchmove", { bubbles: true }));
      } else {
        pointerDown(timeline);
      }
      scrollTo(490);
      window.dispatchEvent(new Event(event));
      vi.advanceTimersByTime(10);
      scrollTo(550);
      expect(collapsed).toBe(false);
    },
  );

  it.each(["key", "primary release", "middle release", "wheel"])(
    "ends toggle-mode middle-click autoscroll on %s without leaving a hold",
    (stop) => {
      pointerDown(content, 1);
      pointerUp(1);
      scrollTo(450);
      vi.advanceTimersByTime(1000);
      expect(collapsed).toBe(true);
      atLogicalEnd = true;
      scrollTo(700);
      expect(collapsed).toBe(false);

      if (stop === "key") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      // Chromium suppresses pointerdown when a click stops active autoscroll.
      if (stop === "primary release") pointerUp();
      if (stop === "middle release") pointerUp(1);
      if (stop === "wheel") {
        content.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 30 }));
      }
      atLogicalEnd = false;
      scrollTo(750);
      expect(collapsed).toBe(false);
    },
  );

  it("ends hold-mode middle autoscroll when the middle button is released", () => {
    pointerDown(content, 1);
    scrollTo(450);
    expect(collapsed).toBe(true);
    atLogicalEnd = true;
    scrollTo(700);
    expect(collapsed).toBe(false);

    pointerUp(1);
    atLogicalEnd = false;
    scrollTo(750);
    expect(collapsed).toBe(false);
  });

  it.each(["second release", "no autoscroll"])(
    "does not track programmatic scrolling after a stationary middle click with %s",
    (end) => {
      pointerDown(content, 1);
      pointerUp(1);
      if (end === "second release") pointerUp(1);
      else vi.advanceTimersByTime(RESET_MS + 1);
      scrollTo(450);
      expect(collapsed).toBe(false);
    },
  );

  it("keeps tracking when native touch panning cancels the pointer stream", () => {
    content.dispatchEvent(new Event("touchmove", { bubbles: true }));
    window.dispatchEvent(new Event("pointercancel"));
    scrollTo(450);
    expect(collapsed).toBe(true);
  });

  it("leaves no gesture active after the composer stops tracking this timeline", () => {
    pointerDown(timeline);
    scrollTo(490);
    dispose();
    vi.advanceTimersByTime(1000);
    scrollTo(400);
    expect(collapsed).toBe(false);
  });
});
