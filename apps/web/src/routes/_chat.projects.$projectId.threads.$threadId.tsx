import { ProjectId, ThreadId } from "@t3tools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { ThreadRouteContent } from "../components/ThreadRouteContent";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { resolveThreadRouteTarget } from "../projectRoute";
import { useStore } from "../store";

function CanonicalThreadRouteView() {
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threads = useStore((store) => store.threads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const projectId = Route.useParams({
    select: (params) => ProjectId.makeUnsafe(params.projectId),
  });
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const target = resolveThreadRouteTarget({ threadId, threads, draftThreadsByThreadId });
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/projects/$projectId/threads/$threadId",
      params: { projectId, threadId },
      search: { diff: undefined },
    });
  }, [navigate, projectId, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/projects/$projectId/threads/$threadId",
      params: { projectId, threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, projectId, threadId]);

  useEffect(() => {
    if (target.kind === "missing") {
      if (threadsHydrated) {
        void navigate({ to: "/", replace: true });
      }
      return;
    }

    if (target.projectId !== projectId) {
      void navigate({
        to: "/projects/$projectId/threads/$threadId",
        params: { projectId: target.projectId, threadId },
        search,
        replace: true,
      });
    }
  }, [navigate, projectId, search, target, threadId, threadsHydrated]);

  if (target.kind === "missing" || target.projectId !== projectId) {
    return null;
  }

  return (
    <ThreadRouteContent
      diffOpen={search.diff === "1"}
      onCloseDiff={closeDiff}
      onOpenDiff={openDiff}
      threadId={threadId}
    />
  );
}

export const Route = createFileRoute("/_chat/projects/$projectId/threads/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: CanonicalThreadRouteView,
});
