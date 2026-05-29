import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffPanelLoadingState } from "../components/DiffPanelShell";
import { ChatRightPanels } from "../components/chat/ChatRightPanels";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  buildOpenDiffSearch,
  type DiffRouteSearch,
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
import { retainActiveThreadDetailSubscription } from "../environments/runtime/service";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { SidebarInset, useSidebar } from "~/components/ui/sidebar";
import {
  closeWorkspaceFilePreview,
  reopenWorkspaceFilePanel,
  type WorkspaceFilePreviewDiffReturnTarget,
  useWorkspaceFilePanelState,
} from "../workspaceFilePreview";

const MISSING_THREAD_ROUTE_RECOVERY_GRACE_MS = 3_000;

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const { openMobile: leftSidebarOpenMobile } = useSidebar();
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
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const diffOpen = search.diff === "1";
  const filePanel = useWorkspaceFilePanelState();
  const filePanelOpen = filePanel.open;
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const markDiffOpened = useCallback(() => {
    markRightPanelUsed("diff");
    setDiffPanelMountState((previous) => {
      if (previous.threadKey === currentThreadKey && previous.hasOpenedDiff) {
        return previous;
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedDiff: true,
      };
    });
  }, [currentThreadKey]);
  const closeDiff = useCallback(() => {
    if (!threadRef || !diffOpen) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => stripDiffSearchParams(previous),
    });
  }, [diffOpen, navigate, threadRef]);
  const openDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markRightPanelUsed("diff");
    markDiffOpened();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) =>
        buildOpenDiffSearch(previous, {
          source: serverThread && !serverThreadStarted ? "unstaged" : undefined,
        }),
    });
  }, [markDiffOpened, navigate, serverThread, serverThreadStarted, threadRef]);
  const openFilePreview = useCallback(() => {
    reopenWorkspaceFilePanel();
  }, []);
  const returnFromFilePreview = useCallback(
    (returnTarget: WorkspaceFilePreviewDiffReturnTarget) => {
      closeWorkspaceFilePreview();
      if (!threadRef) {
        return;
      }
      markRightPanelUsed("diff");
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
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
              : { ...rest, diff: "1" };
        },
      });
    },
    [navigate, threadRef],
  );

  useEffect(() => {
    if (diffOpen) {
      markRightPanelUsed("diff");
    }
  }, [diffOpen]);

  useEffect(() => {
    if (
      !threadRef ||
      !diffOpen ||
      search.diffSource ||
      search.diffTurnId ||
      !serverThread ||
      serverThreadStarted
    ) {
      return;
    }

    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) => buildOpenDiffSearch(previous, { source: "unstaged" }),
    });
  }, [
    diffOpen,
    navigate,
    search.diffSource,
    search.diffTurnId,
    serverThread,
    serverThreadStarted,
    threadRef,
  ]);

  useEffect(() => {
    if (filePanelOpen) {
      markRightPanelUsed("file");
    }
  }, [filePanelOpen]);

  useRegisterRightPanel({
    close: closeDiff,
    enabled: threadRef !== null,
    kind: "diff",
    open: openDiff,
  });
  useRegisterRightPanel({
    close: closeWorkspaceFilePreview,
    enabled: threadRef !== null,
    kind: "file",
    open: openFilePreview,
  });

  useMobileEdgeSwipe({
    blockedByOpenPanelSide: "left",
    enabled: shouldUseDiffSheet && !diffOpen && !leftSidebarOpenMobile,
    onSwipe: openLastUsedRightPanel,
    side: "right",
    startArea: "screen",
    startSurface: "outside-panels",
  });

  useMobileEdgeSwipe({
    action: "close",
    enabled: shouldUseDiffSheet && diffOpen,
    onSwipe: closeDiff,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  useMobileEdgeSwipe({
    action: "close",
    enabled: shouldUseDiffSheet && filePanelOpen,
    onSwipe: closeWorkspaceFilePreview,
    side: "right",
    startArea: "screen",
    startSurface: "panel",
  });

  const isRecoveringMissingThread =
    bootstrapComplete && threadRef !== null && !routeThreadExists && environmentHasAnyThreads;

  useEffect(() => {
    if (!threadRef || draftThreadExists) {
      return;
    }
    return retainActiveThreadDetailSubscription(threadRef.environmentId, threadRef.threadId);
  }, [draftThreadExists, threadRef]);

  useEffect(() => {
    if (!isRecoveringMissingThread) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const latestThreadExists = selectThreadExistsByRef(useStore.getState(), threadRef);
      const latestDraftExists =
        useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null;
      if (!latestThreadExists && !latestDraftExists) {
        void navigate({ to: "/", replace: true });
      }
    }, MISSING_THREAD_ROUTE_RECOVERY_GRACE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isRecoveringMissingThread, navigate, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  const shouldRenderThreadRoute =
    threadRef !== null &&
    (routeThreadExists || draftThreadExists || !bootstrapComplete || isRecoveringMissingThread);

  if (!shouldRenderThreadRoute) {
    return null;
  }

  if (isRecoveringMissingThread) {
    return (
      <SidebarInset
        className="flex h-svh min-h-0 items-center justify-center overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh"
        data-testid="thread-route-recovery"
      >
        <DiffPanelLoadingState label="Loading conversation..." />
      </SidebarInset>
    );
  }

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const shouldRenderFilePanelContent =
    filePanelOpen || filePanel.target !== null || filePanel.explorerContext !== null;

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          onDiffPanelOpen={markDiffOpened}
          reserveTitleBarControlInset={shouldUseDiffSheet || !diffOpen}
          routeKind="server"
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
        useSheet={shouldUseDiffSheet}
        onReturnFromFileToDiff={returnFromFilePreview}
      />
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: ChatThreadRouteView,
});
