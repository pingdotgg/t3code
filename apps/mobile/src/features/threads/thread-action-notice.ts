import { useSyncExternalStore } from "react";

import type { GitActionProgress } from "../../state/use-vcs-action-state";

/**
 * A short app-wide toast for thread actions started from a menu or button (starting a No project
 * thread, moving a thread to a project). Rendered by HardwareKeyboardCommandProvider at the top.
 */
export type ThreadActionNotice = GitActionProgress;

const IDLE: ThreadActionNotice = { phase: "idle", label: null, description: null };
export const THREAD_ACTION_NOTICE_DISMISS_MS = 3_000;

let notice: ThreadActionNotice = IDLE;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function readThreadActionNotice(): ThreadActionNotice {
  return notice;
}

export function dismissThreadActionNotice() {
  clearTimeout(expiry);
  expiry = undefined;
  if (notice === IDLE) return;
  notice = IDLE;
  notify();
}

/**
 * Shows `next`, replacing any notice. A running notice stays until replaced or dismissed; others
 * hide after a few seconds. Returns a dismiss that only hides this notice, not a newer one.
 */
export function showThreadActionNotice(next: ThreadActionNotice): () => void {
  clearTimeout(expiry);
  expiry = undefined;
  notice = next;
  if (next.phase !== "running" && next.phase !== "idle") {
    expiry = setTimeout(dismissThreadActionNotice, THREAD_ACTION_NOTICE_DISMISS_MS);
  }
  notify();
  return () => {
    if (notice === next) dismissThreadActionNotice();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadActionNotice(): ThreadActionNotice {
  return useSyncExternalStore(subscribe, readThreadActionNotice, readThreadActionNotice);
}
