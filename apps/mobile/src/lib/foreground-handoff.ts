/**
 * Tracks app-initiated OS-surface handoffs (image picker, auth tab, share
 * sheet). Android reports the app as backgrounded while one of these covers
 * the activity, so background-triggered work — like a deferred app update
 * restart — has to wait them out instead of tearing down the mid-flow runtime.
 */
let activeHandoffs = 0;

/** Returns an idempotent end function; call it when the handoff resolves. */
export function beginForegroundHandoff(): () => void {
  activeHandoffs += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeHandoffs -= 1;
  };
}

export function isForegroundHandoffActive(): boolean {
  return activeHandoffs > 0;
}
