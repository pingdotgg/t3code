import { type ScopedThreadRef } from "@t3tools/contracts";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { claimThreadOpen } from "@t3tools/client-runtime/state/thread-search";
import { useEffect, useRef } from "react";
import { useUiStateStore } from "../../uiStateStore";
import { threadEnvironment } from "../../state/threads";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";

// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers.
const VISIT_DISPATCH_THROTTLE_MS = 10_000;

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. Keeping it in a leaf lets
// ChatView read the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  const serverThread = useThreadShell(props.threadRef);
  const threadKey = scopedThreadKey(props.threadRef);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLocalLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadKey],
  );
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastVisitDispatchAtRef = useRef(0);
  const recordedOpenRef = useRef<string | null>(null);

  // Opening a thread is one visit that also counts toward search ranking. A
  // palette pick already sent it with the query. It runs before the watermark
  // effect, which then sees this watermark as sent.
  useEffect(() => {
    if (!serverThread?.id) return;
    if (recordedOpenRef.current === threadKey) return;
    recordedOpenRef.current = threadKey;
    // Recorded here even when the server cannot take opens, so recents follow it.
    const claimed = claimThreadOpen(serverThread.environmentId, serverThread.id, Date.now());
    if (!claimed || serverThread.lastVisitedAt === undefined) return;
    lastDispatchedVisitRef.current = `${threadKey}:${serverThread.updatedAt}`;
    lastVisitDispatchAtRef.current = Date.now();
    void visitThreadMutation({
      environmentId: serverThread.environmentId,
      input: {
        threadId: serverThread.id,
        visitedAt: serverThread.updatedAt,
        opened: true,
      },
    });
  }, [
    threadKey,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.lastVisitedAt,
    serverThread?.updatedAt,
    visitThreadMutation,
  ]);

  useEffect(() => {
    if (!serverThread?.id) return;
    const threadUpdatedAt = Date.parse(serverThread.updatedAt);
    if (Number.isNaN(threadUpdatedAt)) return;
    const effectiveLastVisitedAt = resolveThreadLastVisitedAt(
      serverThread.lastVisitedAt,
      activeThreadLocalLastVisitedAt,
    );
    const lastVisitedAt = effectiveLastVisitedAt ? Date.parse(effectiveLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= threadUpdatedAt) return;

    if (serverThread.lastVisitedAt !== undefined) {
      // Dedupe per watermark — the effect re-runs before the command's echo
      // lands. The dedupe also keeps a mark-unread on the open thread sticky:
      // the rewind leaves updatedAt untouched, so the already-dispatched key
      // skips a fresh visit until new activity lands or the thread is reopened.
      const dispatchKey = `${threadKey}:${serverThread.updatedAt}`;
      if (lastDispatchedVisitRef.current === dispatchKey) return;
      const dispatch = () => {
        lastDispatchedVisitRef.current = dispatchKey;
        lastVisitDispatchAtRef.current = Date.now();
        void visitThreadMutation({
          environmentId: serverThread.environmentId,
          input: { threadId: serverThread.id, visitedAt: serverThread.updatedAt },
        });
      };
      const latestRunCompletedAtMs = serverThread.latestRun?.completedAt
        ? Date.parse(serverThread.latestRun.completedAt)
        : NaN;
      const hasUnseenCompletion =
        !Number.isNaN(latestRunCompletedAtMs) &&
        (Number.isNaN(lastVisitedAt) || latestRunCompletedAtMs > lastVisitedAt);
      const elapsed = Date.now() - lastVisitDispatchAtRef.current;
      if (hasUnseenCompletion || elapsed >= VISIT_DISPATCH_THROTTLE_MS) {
        dispatch();
        return;
      }
      const timer = setTimeout(dispatch, VISIT_DISPATCH_THROTTLE_MS - elapsed);
      return () => clearTimeout(timer);
    }

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      serverThread.updatedAt,
    );
  }, [
    activeThreadLocalLastVisitedAt,
    markThreadVisited,
    threadKey,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.lastVisitedAt,
    serverThread?.latestRun?.completedAt,
    serverThread?.updatedAt,
    visitThreadMutation,
  ]);
  return null;
}
