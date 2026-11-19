export interface AppActivity {
  readonly isActive: () => boolean;
  /** Calls back when the app becomes active again; returns the unsubscribe. */
  readonly onActive: (listener: () => void) => () => void;
}

/**
 * Reads now and every `intervalMs`, but only while the app is in the foreground: a focused screen
 * behind Control Center or in the background sends nothing. Coming back reads once at once.
 */
export function pollWhileActive(options: {
  readonly read: () => void;
  readonly intervalMs: number;
  readonly app: AppActivity;
}): () => void {
  const readIfActive = () => {
    if (options.app.isActive()) options.read();
  };
  readIfActive();
  const timer = setInterval(readIfActive, options.intervalMs);
  const unsubscribe = options.app.onActive(options.read);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
