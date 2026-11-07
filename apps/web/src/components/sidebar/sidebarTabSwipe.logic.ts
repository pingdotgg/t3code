// Share of the list width a swipe must cross to switch tabs.
const TAB_SWIPE_COMMIT_FRACTION = 0.5;
// Quiet time that ends a swipe; trackpad momentum keeps wheel events flowing inside it.
export const TAB_SWIPE_GAP_MS = 90;
// After a commit, a magnitude below this counts as the finger at rest.
const REST_PX = 1.5;
// After resting, a same-direction rise this far above the floor is a new swipe.
const RISE_PX = 3;

export type TabSwipeState =
  | { readonly phase: "idle" }
  // Positive offsets move toward the next tab, negative toward the previous one.
  | { readonly phase: "tracking"; readonly offset: number }
  // A swipe committed: the rest of its momentum is swallowed.
  | {
      readonly phase: "momentum";
      readonly sign: 1 | -1;
      readonly previous: number;
      // Lowest magnitude once the wheel started slowing down; Infinity before that.
      readonly floor: number;
    };

export const TAB_SWIPE_IDLE: TabSwipeState = { phase: "idle" };

export interface TabSwipeContext {
  readonly width: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export type TabSwipeOutput =
  // A vertical scroll: leave it to the browser.
  | { readonly kind: "pass" }
  // Horizontal but nothing to draw, such as swallowed momentum.
  | { readonly kind: "hold" }
  | { readonly kind: "track"; readonly offset: number }
  | { readonly kind: "commit"; readonly direction: 1 | -1 };

export interface TabSwipeResult {
  readonly state: TabSwipeState;
  readonly output: TabSwipeOutput;
}

function track(offset: number, deltaX: number, context: TabSwipeContext): TabSwipeResult {
  const next = Math.min(
    context.hasNext ? context.width : 0,
    Math.max(context.hasPrevious ? -context.width : 0, offset + deltaX),
  );
  if (next !== 0 && Math.abs(next) >= context.width * TAB_SWIPE_COMMIT_FRACTION) {
    const sign = next > 0 ? 1 : -1;
    return {
      state: { phase: "momentum", sign, previous: Math.abs(deltaX), floor: Infinity },
      output: { kind: "commit", direction: sign },
    };
  }
  return { state: { phase: "tracking", offset: next }, output: { kind: "track", offset: next } };
}

export function stepTabSwipe(
  state: TabSwipeState,
  input: { readonly deltaX: number; readonly deltaY: number },
  context: TabSwipeContext,
): TabSwipeResult {
  if (Math.abs(input.deltaX) <= Math.abs(input.deltaY)) return { state, output: { kind: "pass" } };
  if (state.phase === "idle") return track(0, input.deltaX, context);
  if (state.phase === "tracking") return track(state.offset, input.deltaX, context);

  // Momentum keeps the committed direction, so a reversal is a new swipe. A same-direction
  // swipe that lands on the momentum shows as a rise after the wheel slowed nearly to rest.
  const magnitude = Math.abs(input.deltaX);
  if (Math.sign(input.deltaX) !== state.sign) return track(0, input.deltaX, context);
  const slowing = state.floor !== Infinity || magnitude < state.previous;
  if (slowing && state.floor <= REST_PX && magnitude > state.floor + RISE_PX) {
    return track(0, input.deltaX, context);
  }
  return {
    state: {
      phase: "momentum",
      sign: state.sign,
      previous: magnitude,
      floor: slowing ? Math.min(state.floor, magnitude) : Infinity,
    },
    output: { kind: "hold" },
  };
}

// The wheel went quiet: a swipe that did not commit springs back.
export function endTabSwipe(state: TabSwipeState): { readonly cancel: boolean } {
  return { cancel: state.phase === "tracking" && state.offset !== 0 };
}
