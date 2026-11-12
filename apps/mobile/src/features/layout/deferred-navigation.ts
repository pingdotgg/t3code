import { recordDiagnostic } from "../diagnostics/diagnostic-log";

/** Hold in-place route changes while a workspace mutation is still running. */
export function createDeferredNavigation() {
  let pending = 0;
  let latest: (() => void) | null = null;
  return {
    run(action: () => void) {
      if (pending > 0) {
        recordDiagnostic({ type: "navigation.gate", phase: "queued", pending });
        latest = action;
      } else action();
    },
    waitFor(operation: Promise<unknown>) {
      pending += 1;
      recordDiagnostic({ type: "navigation.gate", phase: "held", pending });
      const release = () => {
        pending -= 1;
        recordDiagnostic({ type: "navigation.gate", phase: "released", pending });
        if (pending !== 0) return;
        const action = latest;
        latest = null;
        action?.();
      };
      void operation.then(release, release);
    },
  };
}

/**
 * The app's one thread-selection gate: a new-task branch checkout holds
 * split-view thread selection until the draft route can be left.
 */
export const threadSelectionDeferral = createDeferredNavigation();
