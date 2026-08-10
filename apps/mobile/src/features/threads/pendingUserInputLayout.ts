const PENDING_USER_INPUT_MAX_HEIGHT = 560;
const PENDING_USER_INPUT_VERTICAL_GAP = 12;

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

  return Math.min(PENDING_USER_INPUT_MAX_HEIGHT, Math.max(0, availableHeight));
}
