/**
 * Keeps manual usage-refresh state tied to the window it targets.
 *
 * A refresh button can select a new window and start its request in one event.
 * The React effect for the new key must preserve that request rather than
 * treating it as an unrelated window transition.
 */

export interface UsageRefreshState {
  readonly windowKey: string;
  readonly requestId: number;
  readonly refreshing: boolean;
  readonly error: string | null;
}

export function refreshStateForWindowChange(
  state: UsageRefreshState,
  committedWindowKey: string,
  pendingRefreshWindowKey: string,
): UsageRefreshState {
  if (pendingRefreshWindowKey === committedWindowKey) return state;
  return {
    windowKey: committedWindowKey,
    requestId: state.requestId + 1,
    refreshing: false,
    error: null,
  };
}
