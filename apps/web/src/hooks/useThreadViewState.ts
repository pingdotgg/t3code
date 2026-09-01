import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentSupportsViewState, readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

/**
 * Marks a thread viewed or unread. On servers that persist view state the
 * change is a command and every client renders the server's `viewedAt`; on
 * older servers it falls back to this device's local visit store. Like
 * settlement, there is no optimistic override: the UI flips when the shell
 * update arrives.
 */
export function useThreadViewState() {
  const viewThread = useAtomCommand(threadEnvironment.view, { reportFailure: false });
  const markUnreadOnServer = useAtomCommand(threadEnvironment.markUnread, "mark thread unread");
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);

  // viewedThrough is the completion the user looked at, never wall clock, so
  // a completion that lands while the thread is open still shows as unread.
  const markViewed = useCallback(
    (threadRef: ScopedThreadRef, viewedThrough: string) => {
      const supported = readEnvironmentSupportsViewState(threadRef.environmentId);
      // Config still loading: drop the write rather than misfile a server
      // ack in local storage. ChatView re-acks once the config lands.
      if (supported === undefined) return;
      if (!supported) {
        markThreadVisited(scopedThreadKey(threadRef), viewedThrough);
        return;
      }
      // Reopening an already-read thread is a no-op: the server would only
      // re-emit the same boundary, so skip the round trip and the event.
      const viewedAtMs = Date.parse(readThreadShell(threadRef)?.viewedAt ?? "");
      const viewedThroughMs = Date.parse(viewedThrough);
      if (Number.isFinite(viewedAtMs) && Number.isFinite(viewedThroughMs)) {
        if (viewedAtMs >= viewedThroughMs) return;
      }
      void viewThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, viewedThrough },
      });
    },
    [markThreadVisited, viewThread],
  );

  const markUnread = useCallback(
    (threadRef: ScopedThreadRef, latestTurnCompletedAt: string | null | undefined) => {
      const supported = readEnvironmentSupportsViewState(threadRef.environmentId);
      if (supported === undefined) return;
      if (!supported) {
        markThreadUnread(scopedThreadKey(threadRef), latestTurnCompletedAt);
        return;
      }
      void markUnreadOnServer({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    },
    [markThreadUnread, markUnreadOnServer],
  );

  return { markViewed, markUnread };
}
