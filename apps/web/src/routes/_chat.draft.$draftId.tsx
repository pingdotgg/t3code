import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { ChatRightPanels } from "../components/chat/ChatRightPanels";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import {
  buildOpenDiffSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useMobileEdgeSwipe } from "../hooks/useMobileEdgeSwipe";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  markRightPanelUsed,
  openLastUsedRightPanel,
  useRegisterRightPanel,
} from "../rightPanelGesture";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  closeWorkspaceFilePreview,
  reopenWorkspaceFilePanel,
  type WorkspaceFilePreviewDiffReturnTarget,
  useWorkspaceFilePanelState,
} from "../workspaceFilePreview";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { openMobile: leftSidebarOpenMobile } = useSidebar();
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
  const serverThreadHasSubmittedMessage = Boolean(serverThread && serverThread.messages.length > 0);
  const diffOpen = search.diff === "1";
  const filePanel = useWorkspaceFilePanelState();
  const filePanelOpen = filePanel.open;
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    draftId,
    hasOpenedDiff: diffOpen,
  }));
  const hasOpenedDiff =
    diffPanelMountState.draftId === draftId ? diffPanelMountState.hasOpenedDiff : diffOpen;
  const markDiffOpened = useCallback(() => {
    markRightPanelUsed("diff");
    setDiffPanelMountState((previous) => {
      if (previous.draftId === draftId && previous.hasOpenedDiff) {
        return previous;
      }
      return {
        draftId,
        hasOpenedDiff: true,
      };
    });
  }, [draftId]);
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
  const shouldNavigateToCanonicalThread = Boolean(
    canonicalThreadRef && (!draftSession?.promotedTo || serverThreadHasSubmittedMessage),
  );
  const closeDiff = useCallback(() => {
    if (!diffOpen) {
      return;
    }
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      search: (previous) => stripDiffSearchParams(previous),
    });
  }, [diffOpen, draftId, navigate]);
  const openDiff = useCallback(() => {
    if (!draftSession) {
      return;
    }
    markDiffOpened();
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      search: (previous) => buildOpenDiffSearch(previous, { source: "unstaged" }),
    });
  }, [draftId, draftSession, markDiffOpened, navigate]);
  const openFilePanel = useCallback(() => {
    reopenWorkspaceFilePanel();
  }, []);
  const returnFromFilePreview = useCallback(
    (returnTarget: WorkspaceFilePreviewDiffReturnTarget) => {
      closeWorkspaceFilePreview();
      if (!draftSession) {
        return;
      }
      markRightPanelUsed("diff");
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return returnTarget.diffSource
            ? {
                ...buildOpenDiffSearch(previous, { source: returnTarget.diffSource }),
                ...(returnTarget.diffFilePath ? { diffFilePath: returnTarget.diffFilePath } : {}),
              }
            : returnTarget.diffTurnId
              ? {
                  ...rest,
                  diff: "1",
                  diffTurnId: returnTarget.diffTurnId,
                  ...(returnTarget.diffFilePath ? { diffFilePath: returnTarget.diffFilePath } : {}),
                }
              : buildOpenDiffSearch(previous, { source: "unstaged" });
        },
      });
    },
    [draftId, draftSession, navigate],
  );

  useEffect(() => {
    if (!canonicalThreadRef || !shouldNavigateToCanonicalThread) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      search:
        search.diff === "1"
          ? {
              diff: "1",
              ...(search.diffSource
                ? { diffSource: search.diffSource }
                : search.diffTurnId
                  ? {}
                  : { diffSource: "unstaged" as const }),
              ...(search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
              ...(search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
            }
          : {},
      replace: true,
    });
  }, [
    canonicalThreadRef,
    navigate,
    search.diff,
    search.diffFilePath,
    search.diffSource,
    search.diffTurnId,
    shouldNavigateToCanonicalThread,
  ]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  useEffect(() => {
    if (!draftSession || !diffOpen || search.diffSource || search.diffTurnId) {
      return;
    }

    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
      search: (previous) => buildOpenDiffSearch(previous, { source: "unstaged" }),
    });
  }, [diffOpen, draftId, draftSession, navigate, search.diffSource, search.diffTurnId]);

  useEffect(() => {
    if (diffOpen) {
      markRightPanelUsed("diff");
    }
  }, [diffOpen]);

  useEffect(() => {
    if (filePanelOpen) {
      markRightPanelUsed("file");
    }
  }, [filePanelOpen]);

  useRegisterRightPanel({
    close: closeDiff,
    enabled: draftSession !== null,
    kind: "diff",
    open: openDiff,
  });
  useRegisterRightPanel({
    close: closeWorkspaceFilePreview,
    enabled: draftSession !== null,
    kind: "file",
    open: openFilePanel,
  });

  useMobileEdgeSwipe({
    blockedByOpenPanelSide: "left",
    enabled: shouldUseRightPanelSheet && !diffOpen && !filePanelOpen && !leftSidebarOpenMobile,
    onSwipe: openLastUsedRightPanel,
    side: "right",
    startArea: "screen",
    startSurface: "outside-panels",
  });

  useMobileEdgeSwipe({
    action: "close",
    enabled: shouldUseRightPanelSheet && diffOpen,
    onSwipe: closeDiff,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  useMobileEdgeSwipe({
    action: "close",
    enabled: shouldUseRightPanelSheet && filePanelOpen,
    onSwipe: closeWorkspaceFilePreview,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  const shouldRenderFilePanelContent =
    filePanelOpen || filePanel.target !== null || filePanel.explorerContext !== null;
  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          onDiffPanelOpen={markDiffOpened}
          reserveTitleBarControlInset={shouldUseRightPanelSheet || !diffOpen}
          routeKind="draft"
        />
      </SidebarInset>
      <ChatRightPanels
        diff={{
          open: diffOpen,
          onClose: closeDiff,
          onOpen: openDiff,
          renderContent: shouldRenderDiffContent,
        }}
        fileOpen={filePanelOpen}
        renderFileContent={shouldRenderFilePanelContent}
        useSheet={shouldUseRightPanelSheet}
        onReturnFromFileToDiff={returnFromFilePreview}
      />
    </>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: DraftChatThreadRouteView,
});
