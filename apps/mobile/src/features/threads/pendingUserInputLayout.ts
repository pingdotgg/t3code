const PENDING_USER_INPUT_MAX_HEIGHT = 560;
const PENDING_USER_INPUT_MIN_HEIGHT = 160;
const PENDING_USER_INPUT_VERTICAL_GAP = 12;

/**
 * Reserve for a portrait iPhone keyboard with the QuickType bar until a real
 * height has been observed. Overestimating only costs card height; an
 * underestimate would let the card overshoot on the first keyboard open.
 */
export const ESTIMATED_KEYBOARD_HEIGHT = 336;

/**
 * One clock for the questionnaire expand/collapse choreography: the card's
 * enter/exit and the feed-inset glide must share it or they visibly drift.
 * Sized for the near-full-height slide (the card travels its own height),
 * in the same class as the iOS keyboard's ~250ms.
 */
export const USER_INPUT_TOGGLE_DURATION_MS = 220;

export function derivePendingUserInputMaxHeight(input: {
  readonly windowHeight: number;
  readonly keyboardHeight: number;
  readonly navigationHeaderHeight: number;
  readonly composerOverlapHeight: number;
}): number {
  const availableHeight =
    input.windowHeight -
    Math.max(0, input.keyboardHeight) -
    Math.max(0, input.navigationHeaderHeight) -
    Math.max(0, input.composerOverlapHeight) -
    PENDING_USER_INPUT_VERTICAL_GAP;

  return Math.min(
    PENDING_USER_INPUT_MAX_HEIGHT,
    Math.max(PENDING_USER_INPUT_MIN_HEIGHT, availableHeight),
  );
}
