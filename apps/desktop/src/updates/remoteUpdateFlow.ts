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
  // Only "downloaded" is installable: installDownloadedUpdate rejects any
  // other status. A leftover downloadedVersion on an "error" state (e.g. a
  // background updater error) must fall through to the error branch instead
  // of reporting an install that the updater will refuse.
  if (state.status === "downloaded") {
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
