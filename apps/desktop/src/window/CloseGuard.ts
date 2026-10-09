// Plain synchronous BrowserWindow "close" decision logic, in the shape of
// QuitHold: every effect (activity probe, confirm dialog, re-close) is
// injected so the guard stays unit-testable. It covers every path that closes
// the window -- the drawn close button, Ctrl+W (the windowMenu close role),
// and compositor close requests. Explicit quit paths (the Ctrl+Q hold, menu
// Quit) bypass it: they fire app "before-quit" first, which disarms the guard
// through shouldGuard.

export interface CloseGuardOptions {
  readonly platform: NodeJS.Platform;
  // False when the guard is disarmed: no probe wired, the app is already
  // quitting, or closing the window does not end the app (macOS).
  readonly shouldGuard: () => boolean;
  // Resolves the number of local threads with a live agent activity. Must
  // never reject: resolve 0 when the answer is unknown.
  readonly hasRunningActivity: () => Promise<number>;
  readonly confirmClose: (runningCount: number) => Promise<boolean>;
  readonly close: () => void;
}

export function makeCloseGuardHandler(
  options: CloseGuardOptions,
): (event: { preventDefault: () => void }) => void {
  let allowed = false;
  let deciding = false;

  return (event) => {
    if (allowed || options.platform === "darwin" || !options.shouldGuard()) {
      return;
    }
    // A second close request while a decision is pending must not slip
    // through unguarded.
    event.preventDefault();
    if (deciding) return;
    deciding = true;
    void options
      .hasRunningActivity()
      .then((runningCount) => (runningCount === 0 ? true : options.confirmClose(runningCount)))
      .then((mayClose) => {
        deciding = false;
        if (!mayClose) return;
        allowed = true;
        options.close();
      })
      .catch(() => {
        // A failed probe or dialog must never trap the user in an unclosable
        // window; an unreachable local backend also means nothing is running
        // on this machine.
        deciding = false;
        allowed = true;
        options.close();
      });
  };
}
