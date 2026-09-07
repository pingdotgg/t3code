import { describe, expect, it } from "vite-plus/test";

import {
  createComposerScrollGestureState,
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
