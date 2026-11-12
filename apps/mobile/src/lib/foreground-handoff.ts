/** Android handoffs report background; deferred work must wait to avoid tearing down active flows. */
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
