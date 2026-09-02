import type { DesktopUpdateRemoteOutcome, DesktopUpdateState } from "@t3tools/contracts";

/**
 * What a server-triggered update run should do next, given the updater's
 * current state. "wait" means an action (possibly started locally) is in
 * flight and the run should ride along until the next state change.
 */
export type RemoteDesktopUpdateStep =
  | { readonly action: "check" }
  | { readonly action: "download" }
  | { readonly action: "install" }
  | { readonly action: "wait" }
  | {
      readonly action: "done";
      readonly outcome: DesktopUpdateRemoteOutcome;
      readonly reason?: string;
    };

/**
 * How many times this run already issued each action. The caps are what stop
 * a check -> up-to-date -> check loop and endless download retries; they are
 * counts rather than booleans because a state event raced by the local
 * 4-minute poller can re-show an already-handled status once.
 */
export interface RemoteDesktopUpdateAttempts {
  readonly checks: number;
  readonly downloads: number;
}

export const MAX_REMOTE_UPDATE_CHECKS = 2;
export const MAX_REMOTE_UPDATE_DOWNLOADS = 3;

/** Same predicate DesktopUpdates.installDownloadedUpdate uses for admission. */
export function isInstallableDesktopUpdateState(state: DesktopUpdateState): boolean {
  return (
    state.downloadedVersion !== null &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  );
}

export function nextRemoteDesktopUpdateStep(
  state: DesktopUpdateState,
  attempts: RemoteDesktopUpdateAttempts,
  disabledReason: string | null,
): RemoteDesktopUpdateStep {
  if (!state.enabled || state.status === "disabled") {
    return {
      action: "done",
      outcome: "failed",
      reason: disabledReason ?? "Automatic updates are disabled on this machine.",
    };
  }
  // Mirror installDownloadedUpdate's own admission rule exactly, so the run
  // never reports an install that the updater then refuses. A download
  // survives an unrelated background updater error (errorContext null) and
  // a previous failed install (errorContext "install"); it does not survive
  // a check or download error, which fall through to the error branch.
  if (isInstallableDesktopUpdateState(state)) {
    return { action: "install" };
  }
  if (state.status === "downloading" || state.status === "checking") {
    return { action: "wait" };
  }
  if (state.status === "available") {
    if (attempts.downloads >= MAX_REMOTE_UPDATE_DOWNLOADS) {
      return {
        action: "done",
        outcome: "failed",
        reason: state.message ?? "The desktop app failed to download the update.",
      };
    }
    return { action: "download" };
  }
  // "up-to-date" and "error" are retained from earlier/background checks,
  // so before this run has issued its own check they are stale, not
  // terminal: the whole point of a remote request is to look again.
  if (state.status === "up-to-date") {
    if (attempts.checks === 0) {
      return { action: "check" };
    }
    return { action: "done", outcome: "up-to-date" };
  }
  if (state.status === "error") {
    if (attempts.checks === 0) {
      return { action: "check" };
    }
    return {
      action: "done",
      outcome: "failed",
      reason: state.message ?? "The desktop app update failed.",
    };
  }
  // status === "idle"
  if (attempts.checks >= MAX_REMOTE_UPDATE_CHECKS) {
    return {
      action: "done",
      outcome: "failed",
      reason: "The desktop app did not report an update result.",
    };
  }
  return { action: "check" };
}

/**
 * Normalizes an updater message for the `reason` wire field, which is a
 * TrimmedNonEmptyString. Updater messages are plain strings and may be blank;
 * a blank reason would fail encoding and silently drop the terminal report,
 * leaving the server to wait for its timeout.
 */
export function normalizeRemoteUpdateReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : undefined;
}
