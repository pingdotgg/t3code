import { scopeProjectRef } from "@forma/client-runtime";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { LazyWorkspacePanel, preloadWorkspacePanel } from "../components/LazyWorkspacePanel";
import { WorkspacePanelHost } from "../components/WorkspacePanelHost";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  buildWorkspacePanelClosedSearch,
  buildWorkspacePanelFilesSearch,
  parseWorkspacePanelRouteSearch,
  type WorkspacePanelRouteSearch,
} from "../workspacePanelRouteSearch";
import {
  selectEnvironmentState,
  selectProjectByRef,
  selectThreadExistsByRef,
  useStore,
} from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { BottomDrawerHost } from "../components/BottomDrawerHost";
import { SidebarInset } from "~/components/ui/sidebar";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
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
  const activeProjectId = serverThread?.projectId ?? null;
  const activeProjectRef =
    threadRef && activeProjectId ? scopeProjectRef(threadRef.environmentId, activeProjectId) : null;
  const activeProject = useStore((store) =>
    activeProjectRef
      ? selectProjectByRef(store, {
          environmentId: activeProjectRef.environmentId,
          projectId: activeProjectRef.projectId,
        })
      : undefined,
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const panelOpen = search.panel === "1";
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const [workspaceDiffToggleRequestNonce, setWorkspaceDiffToggleRequestNonce] = useState(0);
  const [workspacePanelMountState, setWorkspacePanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedPanel: panelOpen,
  }));
  const hasOpenedPanel =
    workspacePanelMountState.threadKey === currentThreadKey
      ? workspacePanelMountState.hasOpenedPanel
      : panelOpen;
  const markWorkspacePanelOpened = useCallback(() => {
    setWorkspacePanelMountState((previous) => {
      if (previous.threadKey === currentThreadKey && previous.hasOpenedPanel) {
        return previous;
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedPanel: true,
      };
    });
  }, [currentThreadKey]);
  const closePanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => buildWorkspacePanelClosedSearch(previous),
    });
  }, [navigate, threadRef]);
  const openPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    preloadWorkspacePanel();
    markWorkspacePanelOpened();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => buildWorkspacePanelFilesSearch(previous),
    });
  }, [markWorkspacePanelOpened, navigate, threadRef]);
  const requestWorkspaceDiffToggle = useCallback(() => {
    setWorkspaceDiffToggleRequestNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    preloadWorkspacePanel();
  }, []);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!panelOpen) {
      return;
    }
    markWorkspacePanelOpened();
  }, [markWorkspacePanelOpened, panelOpen]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderWorkspacePanel = panelOpen || hasOpenedPanel;
  const workspaceRoot = serverThread?.worktreePath ?? activeProject?.cwd ?? null;

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            reserveTitleBarControlInset={!panelOpen}
            routeKind="server"
            onRequestWorkspaceDiffToggle={requestWorkspaceDiffToggle}
          />
          <BottomDrawerHost />
        </div>
      </SidebarInset>
      <WorkspacePanelHost
        open={panelOpen}
        onClose={closePanel}
        onOpen={openPanel}
        renderPanelContent={shouldRenderWorkspacePanel}
      >
        {(mode) => (
          <LazyWorkspacePanel
            mode={mode}
            routeTarget={{ kind: "server", threadRef }}
            environmentId={threadRef.environmentId}
            panelKey={currentThreadKey ?? `${threadRef.environmentId}:${threadRef.threadId}`}
            workspaceRoot={workspaceRoot}
            activeProjectRef={activeProjectRef}
            supportsDiff={true}
            requestedDiffToggleNonce={workspaceDiffToggleRequestNonce}
          />
        )}
      </WorkspacePanelHost>
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseWorkspacePanelRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<WorkspacePanelRouteSearch>(["panel", "diff"])],
  },
  component: ChatThreadRouteView,
});
