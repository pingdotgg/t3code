/**
 * iOS form sheets often keep the presenting screen focused, so a swipe
 * dismiss never re-runs useFocusEffect. JS then thinks the picker is still
 * open and later model/effort taps no-op. The stack is the source of truth.
 */
export function stackContainsRouteName(
  routes: ReadonlyArray<{ readonly name: string }> | undefined,
  name: string,
): boolean {
  return routes?.some((route) => route.name === name) === true;
}

export function settingsSheetRouteDidDismiss(input: {
  readonly presented: boolean;
  readonly sheetRouteVisible: boolean;
}): boolean {
  return input.presented && !input.sheetRouteVisible;
}
