import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

import { resolveDesktopUpdateButtonAction } from "./components/desktopUpdate.logic";

type ThreadActivity = Pick<
  OrchestrationThreadShell,
  "session" | "latestTurn" | "backgroundLiveness" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/** Include background agents and input waits even after the foreground turn settles. */
export function hasDesktopUpdateBlockingWork(thread: ThreadActivity): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  );
}

type SchedulerState = {
  readonly dialogVersion: string | null;
  readonly scheduledVersion: string | null;
  readonly installing: boolean;
};

/** One schedule for all update entry points; a failed install requires a new user action. */
export function createDesktopUpdateScheduler() {
  const store = createStore<SchedulerState>(() => ({
    dialogVersion: null,
    scheduledVersion: null,
    installing: false,
  }));
  let generation = 0;
  const cancel = () => {
    generation += 1;
    store.setState({ dialogVersion: null, scheduledVersion: null });
  };
  return {
    store,
    open(state: DesktopUpdateState) {
      if (store.getState().installing || resolveDesktopUpdateButtonAction(state) !== "install")
        return;
      generation += 1;
      store.setState({ dialogVersion: state.downloadedVersion, scheduledVersion: null });
    },
    close() {
      generation += 1;
      store.setState({ dialogVersion: null });
    },
    cancel,
    schedule() {
      const version = store.getState().dialogVersion;
      if (!version) return;
      generation += 1;
      store.setState({ dialogVersion: null, scheduledVersion: version });
    },
    async install(input: {
      readonly whenIdle: boolean;
      readonly isIdle: () => boolean;
      readonly getUpdateState: () => Promise<DesktopUpdateState>;
      readonly installUpdate: () => Promise<DesktopUpdateActionResult>;
      readonly onError: (message: string) => void;
    }) {
      const current = store.getState();
      const version = input.whenIdle ? current.scheduledVersion : current.dialogVersion;
      if (!version || current.installing || (input.whenIdle && !input.isIdle())) return;
      const attempt = generation;
      let installStarted = false;
      store.setState({ installing: true });
      try {
        const update = await input.getUpdateState();
        if (attempt !== generation) return;
        if (
          update.downloadedVersion !== version ||
          resolveDesktopUpdateButtonAction(update) !== "install"
        ) {
          cancel();
          input.onError("The selected update is no longer available. Select an update again.");
          return;
        }
        // Recheck after IPC: agents may have started or a connection may have dropped.
        if (input.whenIdle && !input.isIdle()) return;
        installStarted = true;
        store.setState({ dialogVersion: null, scheduledVersion: null, installing: true });
        const result = await input.installUpdate();
        if (!result.accepted || !result.completed) {
          input.onError(
            result.state.message ?? "The update could not be installed. Please try again.",
          );
        }
      } catch (error) {
        if (attempt === generation || installStarted) {
          cancel();
          input.onError(
            error instanceof Error ? error.message : "The update could not be installed.",
          );
        }
      } finally {
        store.setState({ installing: false });
      }
    },
  };
}

export const desktopUpdateScheduler = createDesktopUpdateScheduler();
