import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isOrchestrationV2InternalSubagentThread } from "@t3tools/contracts";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteRenderState,
} from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";
import { useEnvironmentThreadRefs, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { orchestrationEnvironment } from "../state/orchestration";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const shouldResolveHiddenThread =
    bootstrapComplete && threadRef !== null && serverThreadShell === null && !draftThreadExists;
  const hiddenThreadProjection = useEnvironmentQuery(
    shouldResolveHiddenThread
      ? orchestrationEnvironment.v2.threadProjection({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const routeThread = serverThreadShell ?? hiddenThreadProjection.data?.thread ?? null;
  // Hidden provider child threads are intentionally absent from the compact
  // shell snapshot. Let the targeted projection lookup settle before
  // treating a deep link as missing, so the route can redirect to its parent.
  const routeLookupComplete =
    routeThread !== null || hiddenThreadProjection.error !== null || draftThreadExists;
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: bootstrapComplete && routeLookupComplete,
    serverThreadExists: routeThread !== null,
    serverThreadDeleted: routeThread?.deletedAt != null,
    draftThreadExists,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const subagentParentThreadId =
    routeThread && isOrchestrationV2InternalSubagentThread(routeThread)
      ? routeThread.lineage.parentThreadId
      : null;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (renderState === "missing" && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, threadRef]);

  useEffect(() => {
    if (!threadRef || !routeThread || !isOrchestrationV2InternalSubagentThread(routeThread)) {
      return;
    }
    if (subagentParentThreadId === null) {
      void navigate({ to: "/", replace: true });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: threadRef.environmentId,
        threadId: subagentParentThreadId,
      }),
      replace: true,
    });
  }, [navigate, routeThread, subagentParentThreadId, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (
    !threadRef ||
    renderState !== "ready" ||
    (routeThread !== null && isOrchestrationV2InternalSubagentThread(routeThread))
  ) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
