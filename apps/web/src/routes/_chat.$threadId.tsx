import { ThreadId } from "@repo/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import ChatView from "../components/ChatView";
import { useComposerDraftStore } from "../composerDraftStore";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import WorktreeChatWorkspace from "../components/WorktreeChatWorkspace";
import { useStore } from "../store";
import { SidebarInset } from "~/components/ui/sidebar";

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const routeThread = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId) ?? null,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const allThreads = useStore((store) => store.threads);
  const allDraftThreads = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const routeThreadExists = routeThread !== null || draftThread !== null;
  const lastResolvedWorktreeIdRef = useRef(
    routeThread?.worktreeId ?? draftThread?.worktreeId ?? null,
  );

  useEffect(() => {
    const resolvedWorktreeId = routeThread?.worktreeId ?? draftThread?.worktreeId ?? null;
    if (resolvedWorktreeId) {
      lastResolvedWorktreeIdRef.current = resolvedWorktreeId;
    }
  }, [draftThread?.worktreeId, routeThread?.worktreeId]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      const lastResolvedWorktreeId = lastResolvedWorktreeIdRef.current;
      const fallbackThread = lastResolvedWorktreeId
        ? [
            ...allThreads
              .filter((thread) => thread.worktreeId === lastResolvedWorktreeId)
              .map((thread) => ({ id: thread.id, createdAt: thread.createdAt })),
            ...Object.entries(allDraftThreads)
              .filter(([, draft]) => draft.worktreeId === lastResolvedWorktreeId)
              .map(([draftThreadId, draft]) => ({
                id: draftThreadId as ThreadId,
                createdAt: draft.createdAt,
              })),
          ].toSorted(
            (left, right) =>
              Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
              right.id.localeCompare(left.id),
          )[0]
        : null;

      if (fallbackThread) {
        void navigate({
          to: "/$threadId",
          params: { threadId: fallbackThread.id },
          replace: true,
        });
        return;
      }

      void navigate({ to: "/", replace: true });
      return;
    }
  }, [allDraftThreads, allThreads, navigate, routeThreadExists, threadsHydrated]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  const resolvedWorktreeId = routeThread?.worktreeId ?? draftThread?.worktreeId ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {resolvedWorktreeId ? (
        <WorktreeChatWorkspace
          key={resolvedWorktreeId}
          threadId={threadId}
          worktreeId={resolvedWorktreeId}
        />
      ) : (
        <ChatView threadId={threadId} />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
