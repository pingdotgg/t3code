import { describe, expect, it } from "vite-plus/test";

import {
  cycleRecentThread,
  EMPTY_THREAD_RECENCY_STATE,
  endThreadRecencyWalk,
  recordThreadVisit,
  type ThreadRecencyState,
} from "./threadRecency";

const known = new Set(["a", "b", "c", "d"]);
const isKnownThread = (key: string) => known.has(key);

function visit(...keys: Array<string | null>): ThreadRecencyState {
  return keys.reduce(recordThreadVisit, EMPTY_THREAD_RECENCY_STATE);
}

describe("threadRecency", () => {
  it("orders visits most recent first without duplicates", () => {
    expect(visit("a", "b", "a", "c", null).history).toEqual(["c", "a", "b"]);
  });

  it("a single press jumps to the previously visited thread", () => {
    const { target } = cycleRecentThread(visit("a", "b"), {
      currentThreadKey: "b",
      isKnownThread,
    });
    expect(target).toBe("a");
  });

  it("pressing again after release flips back", () => {
    const first = cycleRecentThread(visit("a", "b"), { currentThreadKey: "b", isKnownThread });
    const released = recordThreadVisit(endThreadRecencyWalk(first.state), first.target);
    const second = cycleRecentThread(released, { currentThreadKey: "a", isKnownThread });
    expect(second.target).toBe("b");
  });

  it("holding the modifier walks further back and wraps", () => {
    let state = visit("a", "b", "c");
    const steps: Array<string | null> = [];
    for (let index = 0; index < 4; index += 1) {
      const step = cycleRecentThread(state, { currentThreadKey: "c", isKnownThread });
      // Route changes during the walk must not reorder the list.
      state = recordThreadVisit(step.state, step.target);
      steps.push(step.target);
    }
    expect(steps).toEqual(["b", "a", "c", "b"]);
  });

  it("ending the walk promotes the landed thread even if the route has not caught up", () => {
    let state = visit("a", "b", "c");
    state = cycleRecentThread(state, { currentThreadKey: "c", isKnownThread }).state;
    state = cycleRecentThread(state, { currentThreadKey: "c", isKnownThread }).state;
    state = endThreadRecencyWalk(state);
    expect(state.walkKey).toBeNull();
    expect(state.history).toEqual(["a", "c", "b"]);
    // The route effect firing afterwards with the same thread is a no-op.
    expect(recordThreadVisit(state, "a")).toBe(state);
  });

  it("keeps its place when an earlier entry disappears mid-walk", () => {
    let state = visit("a", "b", "c", "d");
    state = cycleRecentThread(state, { currentThreadKey: "d", isKnownThread }).state;
    expect(state.walkKey).toBe("c");
    const next = cycleRecentThread(state, {
      currentThreadKey: "c",
      isKnownThread: (key) => key !== "d" && isKnownThread(key),
    });
    expect(next.target).toBe("b");
  });

  it("skips threads that no longer exist", () => {
    const { target, state } = cycleRecentThread(visit("gone", "a", "b"), {
      currentThreadKey: "b",
      isKnownThread,
    });
    expect(target).toBe("a");
    expect(state.history).toEqual(["b", "a"]);
  });

  it("does nothing with fewer than two threads", () => {
    expect(
      cycleRecentThread(visit("a"), { currentThreadKey: "a", isKnownThread }).target,
    ).toBeNull();
    expect(
      cycleRecentThread(EMPTY_THREAD_RECENCY_STATE, { currentThreadKey: null, isKnownThread })
        .target,
    ).toBeNull();
  });

  it("starts the walk from the current thread even if it was not recorded", () => {
    const { target } = cycleRecentThread(visit("a", "b"), {
      currentThreadKey: "c",
      isKnownThread,
    });
    expect(target).toBe("b");
  });
});
