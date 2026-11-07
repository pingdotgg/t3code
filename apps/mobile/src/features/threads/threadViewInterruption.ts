export interface ThreadViewState {
  readonly key: string;
  /** The view began, or has since been, hidden or syncing, so reading waits for it to settle. */
  readonly interrupted: boolean;
}

/** The next view state for the shown thread; returns `previous` itself when nothing changed. */
export function nextThreadViewState(
  previous: ThreadViewState | null,
  key: string | null,
  visible: boolean,
): ThreadViewState | null {
  if (key === null) return null;
  if (previous?.key !== key) return { key, interrupted: !visible };
  if (!visible && !previous.interrupted) return { key, interrupted: true };
  return previous;
}
