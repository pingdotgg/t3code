import { describe, expect, it } from "vite-plus/test";

import {
  endTabSwipe,
  stepTabSwipe,
  TAB_SWIPE_IDLE,
  type TabSwipeOutput,
  type TabSwipeState,
} from "./sidebarTabSwipe.logic";

const BOTH = { width: 300, hasPrevious: true, hasNext: true };

function run(deltas: readonly number[], context = BOTH, from: TabSwipeState = TAB_SWIPE_IDLE) {
  let state = from;
  const outputs: TabSwipeOutput[] = [];
  for (const deltaX of deltas) {
    const result = stepTabSwipe(state, { deltaX, deltaY: 0 }, context);
    state = result.state;
    outputs.push(result.output);
  }
  return { state, outputs };
}

describe("stepTabSwipe", () => {
  it("follows horizontal movement and leaves vertical scrolling alone", () => {
    const { state, outputs } = run([40, 40, -30]);
    expect(outputs.map((output) => output.kind === "track" && output.offset)).toEqual([40, 80, 50]);
    expect(stepTabSwipe(state, { deltaX: 5, deltaY: 200 }, BOTH)).toEqual({
      state,
      output: { kind: "pass" },
    });
  });

  it("only moves toward a neighbour that exists", () => {
    const lastTab = { width: 300, hasPrevious: true, hasNext: false };
    expect(run([200], lastTab).outputs).toEqual([{ kind: "track", offset: 0 }]);
    expect(run([-100], lastTab).outputs).toEqual([{ kind: "track", offset: -100 }]);
  });

  it("commits once the offset crosses half the width, in either direction", () => {
    expect(run([100, 60]).outputs.at(-1)).toEqual({ kind: "commit", direction: 1 });
    expect(run([-160]).outputs.at(-1)).toEqual({ kind: "commit", direction: -1 });
  });

  it("swallows the momentum of a committed swipe", () => {
    const committed = run([160]).state;
    const tail = run([20, 30, 18, 9, 4, 2, 1, 1], BOTH, committed);
    expect(tail.outputs.every((output) => output.kind === "hold")).toBe(true);
  });

  it("starts a new swipe on a reversal or a rise after the momentum came to rest", () => {
    const committed = run([160]).state;
    expect(run([-20], BOTH, committed).outputs).toEqual([{ kind: "track", offset: -20 }]);
    const rested = run([12, 6, 1], BOTH, committed).state;
    expect(run([8], BOTH, rested).outputs).toEqual([{ kind: "track", offset: 8 }]);
  });
});

describe("endTabSwipe", () => {
  it("springs back only a swipe that moved and did not commit", () => {
    expect(endTabSwipe(run([80]).state)).toEqual({ cancel: true });
    expect(endTabSwipe(run([160]).state)).toEqual({ cancel: false });
    expect(endTabSwipe(TAB_SWIPE_IDLE)).toEqual({ cancel: false });
  });
});
