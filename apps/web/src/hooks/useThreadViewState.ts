import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { readEnvironmentSupportsViewState, readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useUiStateStore } from "../uiStateStore";
import { useAtomCommand } from "../state/use-atom-command";

function timestampCovers(timestamp: string | undefined, target: string): boolean {
  if (timestamp === undefined) return false;
  const timestampMs = Date.parse(timestamp);
  const targetMs = Date.parse(target);
  return Number.isFinite(timestampMs) && Number.isFinite(targetMs) && timestampMs >= targetMs;
}

/** Keeps the local compatibility marker and the server view marker in sync. */
export function useThreadViewState() {
  const markLocalViewed = useUiStateStore((state) => state.markThreadVisited);
  const markLocalUnread = useUiStateStore((state) => state.markThreadUnread);
  const setPending = useUiStateStore((state) => state.setThreadViewStatePending);
  const clearPending = useUiStateStore((state) => state.clearThreadViewStatePending);
  const viewThread = useAtomCommand(threadEnvironment.view, { reportFailure: false });
  const markUnreadOnServer = useAtomCommand(threadEnvironment.markUnread, "thread mark unread");

  const markViewed = useCallback(
    (threadRef: ScopedThreadRef, viewedThrough: string) => {
      const threadKey = scopedThreadKey(threadRef);
      if (!readEnvironmentSupportsViewState(threadRef.environmentId)) {
        markLocalViewed(threadKey, viewedThrough);
        return;
      }
      const thread = readThreadShell(threadRef);
      if (timestampCovers(thread?.viewedAt, viewedThrough)) return;
      const pending = { kind: "viewed", targetAt: viewedThrough } as const;
      setPending(threadKey, pending);
      markLocalViewed(threadKey, viewedThrough);
      void viewThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, viewedThrough },
      }).then(() => clearPending(threadKey, pending));
    },
    [clearPending, markLocalViewed, setPending, viewThread],
  );

  const markUnread = useCallback(
    (threadRef: ScopedThreadRef, latestTurnCompletedAt: string | null | undefined) => {
      const threadKey = scopedThreadKey(threadRef);
      if (
        latestTurnCompletedAt == null ||
        !readEnvironmentSupportsViewState(threadRef.environmentId)
      ) {
        markLocalUnread(threadKey, latestTurnCompletedAt);
        return;
      }
      const pending = { kind: "unread", targetAt: latestTurnCompletedAt } as const;
      setPending(threadKey, pending);
      markLocalUnread(threadKey, latestTurnCompletedAt);
      void markUnreadOnServer({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }).then(() => clearPending(threadKey, pending));
    },
    [clearPending, markLocalUnread, markUnreadOnServer, setPending],
  );

  return useMemo(() => ({ markViewed, markUnread }), [markUnread, markViewed]);
}
