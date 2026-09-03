export type ComposerScrollGestureState = {
  accumulatedDeltaPx: number;
  collapseSuppressed: boolean;
  lastEventAt: number;
};

export function createComposerScrollGestureState(): ComposerScrollGestureState {
  return {
    accumulatedDeltaPx: 0,
    collapseSuppressed: false,
    lastEventAt: Number.NEGATIVE_INFINITY,
  };
}

export function resetComposerScrollGesture(state: ComposerScrollGestureState): void {
  state.accumulatedDeltaPx = 0;
  state.collapseSuppressed = false;
  state.lastEventAt = Number.NEGATIVE_INFINITY;
}

export function suppressActiveComposerScrollGesture(
  state: ComposerScrollGestureState,
  now: number,
  gestureResetMs: number,
): void {
  if (now - state.lastEventAt <= gestureResetMs) {
    state.collapseSuppressed = true;
  }
}

export function recordComposerScrollGestureEvent(
  state: ComposerScrollGestureState,
  input: {
    now: number;
    deltaPx: number;
    collapseThresholdPx: number;
    collapseEligible: boolean;
    canScrollInGestureDirection: boolean;
    scrollsTowardLogicalEnd: boolean;
  },
): boolean {
  state.lastEventAt = input.now;
  if (
    state.collapseSuppressed ||
    !input.collapseEligible ||
    !input.canScrollInGestureDirection ||
    input.scrollsTowardLogicalEnd
  ) {
    state.accumulatedDeltaPx = 0;
    return false;
  }

  state.accumulatedDeltaPx += input.deltaPx;
  if (state.accumulatedDeltaPx < input.collapseThresholdPx) {
    return false;
  }

  state.accumulatedDeltaPx = 0;
  return true;
}
