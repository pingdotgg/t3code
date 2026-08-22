import type { EnvironmentConnectAuthState } from "@t3tools/contracts";

export function isDesktopConnectAuthIdentityPending(
  state: EnvironmentConnectAuthState | null,
): boolean {
  return state?.authorized === true && state.accountId === null;
}

export function startSettledPolling(task: () => Promise<void>, intervalMs: number): () => void {
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    await task();
    if (!cancelled) {
      timeout = setTimeout(poll, intervalMs);
    }
  };

  timeout = setTimeout(poll, intervalMs);
  return () => {
    cancelled = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  };
}

export function shouldRetryDesktopConnectAuthState(
  state: EnvironmentConnectAuthState | null,
): boolean {
  // Legacy CLI credentials are authorized before the server lazily backfills
  // their Clerk account id. Keep polling so the desktop can reach a usable
  // signed-in state without requiring a focus change or another login.
  return state === null || isDesktopConnectAuthIdentityPending(state);
}
