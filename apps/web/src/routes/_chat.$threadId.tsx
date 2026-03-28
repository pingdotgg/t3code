import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { resolveThreadRouteTarget } from "../projectRoute";
import { useStore } from "../store";

function LegacyChatThreadRedirectView() {
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threads = useStore((store) => store.threads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const target = resolveThreadRouteTarget({ threadId, threads, draftThreadsByThreadId });

  useEffect(() => {
    if (target.kind === "missing") {
      if (threadsHydrated) {
        void navigate({ to: "/", replace: true });
      }
      return;
    }

    void navigate({
      to: "/projects/$projectId/threads/$threadId",
      params: { projectId: target.projectId, threadId },
      search,
      replace: true,
    });
  }, [navigate, search, target, threadId, threadsHydrated]);

  return null;
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: LegacyChatThreadRedirectView,
});
