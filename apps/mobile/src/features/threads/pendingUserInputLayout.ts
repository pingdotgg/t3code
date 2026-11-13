const PENDING_USER_INPUT_MAX_HEIGHT = 560;
const PENDING_USER_INPUT_MIN_HEIGHT = 160;
const PENDING_USER_INPUT_VERTICAL_GAP = 12;

export const ESTIMATED_KEYBOARD_HEIGHT = 336;

/** Card transitions and feed insets must share timing to avoid drift. */
export const USER_INPUT_TOGGLE_DURATION_MS = 220;

export function derivePendingUserInputMaxHeight(input: {
  readonly windowHeight: number;
  readonly keyboardHeight: number;
  readonly navigationHeaderHeight: number;
  readonly composerOverlapHeight: number;
}): number {
  "worklet";
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

/** Content offset that brings a child fully into view, or null when it already is. */
export function deriveRevealScrollOffset(input: {
  readonly top: number;
  readonly height: number;
  readonly viewportHeight: number;
  readonly offset: number;
}): number | null {
  const bottom = input.top + input.height;
  const viewportBottom = input.offset + input.viewportHeight;
  // A child that cannot fit is left where it overlaps, so its caret stays where the user put it.
  if (input.height > input.viewportHeight && input.top < viewportBottom && bottom > input.offset) {
    return null;
  }
  if (input.top < input.offset) return input.top;
  if (bottom > viewportBottom) {
    return Math.min(input.top, bottom - input.viewportHeight);
  }
  return null;
}
