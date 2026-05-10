import { scopeProjectRef } from "@forma/client-runtime";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import ChatView from "../components/ChatView";
import { BottomDrawerHost } from "../components/BottomDrawerHost";
import { threadHasStarted } from "../components/ChatView.logic";
import { LazyWorkspacePanel, preloadWorkspacePanel } from "../components/LazyWorkspacePanel";
import { WorkspacePanelHost } from "../components/WorkspacePanelHost";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  buildDiffClosedSearch,
  buildDiffFilesSearch,
  type DiffRouteSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { SidebarInset } from "../components/ui/sidebar";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { selectProjectByRef, useStore } from "../store";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const search = Route.useSearch();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStarted
          ? draftSession.promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [draftSession?.promotedTo, serverThread, serverThreadStarted],
  );
  const activeProjectRef = draftSession
    ? scopeProjectRef(draftSession.environmentId, draftSession.projectId)
    : null;
  const activeProject = useStore((store) =>
    activeProjectRef
      ? selectProjectByRef(store, {
          environmentId: activeProjectRef.environmentId,
          projectId: activeProjectRef.projectId,
        })
      : undefined,
  );
  const panelOpen = search.diff === "1";
  const panelKey = `draft:${draftId}`;
  const [workspacePanelMountState, setWorkspacePanelMountState] = useState(() => ({
    panelKey,
    hasOpenedPanel: panelOpen,
  }));
  const hasOpenedPanel =
    workspacePanelMountState.panelKey === panelKey
      ? workspacePanelMountState.hasOpenedPanel
      : panelOpen;
  const markWorkspacePanelOpened = useCallback(() => {
    setWorkspacePanelMountState((previous) => {
      if (previous.panelKey === panelKey && previous.hasOpenedPanel) {
        return previous;
      }
      return {
        panelKey,
        hasOpenedPanel: true,
      };
    });
  }, [panelKey]);
  const closePanel = useCallback(() => {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(draftId),
      search: (previous) => buildDiffClosedSearch(previous),
    });
  }, [draftId, navigate]);
  const openPanel = useCallback(() => {
    preloadWorkspacePanel();
    markWorkspacePanelOpened();
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(draftId),
      search: (previous) => buildDiffFilesSearch(previous),
    });
  }, [draftId, markWorkspacePanelOpened, navigate]);

  useEffect(() => {
    preloadWorkspacePanel();
  }, []);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  useEffect(() => {
    if (!panelOpen) {
      return;
    }
    markWorkspacePanelOpened();
  }, [markWorkspacePanelOpened, panelOpen]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatView
            environmentId={canonicalThreadRef.environmentId}
            threadId={canonicalThreadRef.threadId}
            routeKind="server"
          />
          <BottomDrawerHost />
        </div>
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  const workspaceRoot = draftSession.worktreePath ?? activeProject?.cwd ?? null;
  const shouldRenderWorkspacePanel = panelOpen || hasOpenedPanel;

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatView
            draftId={draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            reserveTitleBarControlInset={!panelOpen}
            routeKind="draft"
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
            routeTarget={{ kind: "draft", draftId }}
            environmentId={draftSession.environmentId}
            panelKey={panelKey}
            workspaceRoot={workspaceRoot}
            activeProjectRef={activeProjectRef}
            supportsDiff={false}
          />
        )}
      </WorkspacePanelHost>
    </>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: DraftChatThreadRouteView,
});
