import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentSupportsVisitedTracking, readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

/**
 * Marks a thread visited or unread. Servers with visited tracking own the
 * watermark: the change is a command and every client renders the server's
 * `lastVisitedAt`. Older servers fall back to this device's local visit
 * store. Like settlement, there is no optimistic override: the UI flips when
 * the shell update arrives.
 */
export function useThreadVisitedState() {
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markUnreadOnServer = useAtomCommand(threadEnvironment.markUnread, "mark thread unread");
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);

  // visitedAt is the watermark of thread state the user has seen, never wall
  // clock. Stamping updatedAt on open (or a completion's completedAt from a
  // wake pill) means later activity still compares as unseen.
  const markVisited = useCallback(
    (threadRef: ScopedThreadRef, visitedAt: string) => {
      const supported = readEnvironmentSupportsVisitedTracking(threadRef.environmentId);
      // Config still loading: drop the write rather than misfile a server
      // visit in local storage. ChatView re-visits once the config lands.
      if (supported === undefined) return;
      if (!supported) {
        markThreadVisited(scopedThreadKey(threadRef), visitedAt);
        return;
      }
      // The server keeps the max, so a visit that would not move the
      // watermark is skipped to save the round trip and the event.
      const currentMs = Date.parse(readThreadShell(threadRef)?.lastVisitedAt ?? "");
      const nextMs = Date.parse(visitedAt);
      if (Number.isFinite(currentMs) && Number.isFinite(nextMs) && currentMs >= nextMs) return;
      void visitThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, visitedAt },
      });
    },
    [markThreadVisited, visitThread],
  );

  const markUnread = useCallback(
    (threadRef: ScopedThreadRef, latestTurnCompletedAt: string | null | undefined) => {
      const supported = readEnvironmentSupportsVisitedTracking(threadRef.environmentId);
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

  return { markVisited, markUnread };
}
