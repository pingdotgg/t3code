const PENDING_USER_INPUT_MAX_HEIGHT = 560;
const PENDING_USER_INPUT_MIN_HEIGHT = 160;
const PENDING_USER_INPUT_VERTICAL_GAP = 12;

export const ESTIMATED_KEYBOARD_HEIGHT = 336;

/**
 * One clock for the questionnaire expand/collapse choreography: the card's
 * enter/exit and the feed-inset glide must share it or they visibly drift.
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
