import type { EnvironmentConnectAuthState } from "@t3tools/contracts";

export function shouldRetryDesktopConnectAuthState(
  state: EnvironmentConnectAuthState | null,
): boolean {
  // Legacy CLI credentials are authorized before the server lazily backfills
  // their Clerk account id. Keep polling so the desktop can reach a usable
  // signed-in state without requiring a focus change or another login.
  return state === null || (state.authorized && state.accountId === null);
}
