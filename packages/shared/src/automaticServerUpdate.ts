export interface AutomaticServerUpdateThreadActivity {
  readonly session?: {
    readonly status?: string;
    readonly activeTurnId?: unknown;
  } | null;
  readonly latestTurn?: { readonly state?: string } | null;
  readonly backgroundLiveness?: unknown;
}

export function isAutomaticServerUpdateThreadActive(
  thread: AutomaticServerUpdateThreadActivity,
): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null
  );
}

export function hasAutomaticServerUpdateActiveWork(
  threads: ReadonlyArray<AutomaticServerUpdateThreadActivity>,
): boolean {
  return threads.some(isAutomaticServerUpdateThreadActive);
}
