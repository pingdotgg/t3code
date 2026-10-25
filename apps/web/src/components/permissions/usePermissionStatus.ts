import { useState, useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";

const POLL_INTERVAL_MS = 1500;
const CHECK_FAILED_MESSAGE = "Could not check permissions. We'll try again automatically.";

interface PermissionSnapshot<Id extends string> {
  readonly status: Record<Id, boolean>;
  readonly error: string | null;
}

/**
 * Holds the last permission check result and polls while subscribed: on
 * subscribe, every interval, and when the window regains focus or visibility.
 * Checks are skipped while the tab is hidden and never overlap.
 */
export function createPermissionPoller<Id extends string>(
  check: () => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
) {
  let snapshot: PermissionSnapshot<Id> = { status: initialStatus, error: null };
  return {
    getSnapshot: () => snapshot,
    subscribe(onChange: () => void): () => void {
      let disposed = false;
      let checking = false;
      const publish = (next: PermissionSnapshot<Id>) => {
        if (disposed) return;
        snapshot = next;
        onChange();
      };
      const refresh = async () => {
        if (disposed || checking || !getDocumentActivity().visible) return;
        checking = true;
        try {
          publish({ status: await check(), error: null });
        } catch {
          publish({ status: snapshot.status, error: CHECK_FAILED_MESSAGE });
        }
        checking = false;
      };
      void refresh();
      const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
      let previous = getDocumentActivity();
      const stopActivity = subscribeDocumentActivity(() => {
        const next = getDocumentActivity();
        const regained = (next.focused && !previous.focused) || next.visible !== previous.visible;
        previous = next;
        if (regained) void refresh();
      });
      return () => {
        disposed = true;
        clearInterval(timer);
        stopActivity();
      };
    },
  };
}

const noopSubscribe = () => () => {};

/**
 * `check` and `initialStatus` are read once, when the component mounts, so the
 * subscription only restarts when `enabled` flips. Key the component if what it
 * checks can change.
 */
export function usePermissionStatus<Id extends string>(
  check: () => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
  enabled = true,
) {
  const [poller] = useState(() => createPermissionPoller(check, initialStatus));
  const { status, error } = useSyncExternalStore(
    enabled ? poller.subscribe : noopSubscribe,
    poller.getSnapshot,
  );
  return {
    status,
    error,
    isReady: (required: readonly Id[]) => error === null && required.every((id) => status[id]),
  };
}
