import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { buildOpenDiffSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { buildOpenPreviewSearch, stripPreviewSearchParams } from "../previewRouteSearch";
import {
  getRightPanelMode,
  parseRightPanelRouteSearch,
  type RightPanelMode,
  type RightPanelRouteSearch,
} from "../rightPanelRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const PreviewPanel = lazy(() => import("../components/PreviewPanel"));
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

function closeRightPanelSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "preview"> & RightPanelRouteSearch {
  return {
    ...stripPreviewSearchParams(stripDiffSearchParams(params)),
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
  } as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "preview"> & RightPanelRouteSearch;
}

const RightPanelLoadingFallback = (props: { mode: DiffPanelMode; label: string }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label={props.label} />
    </DiffPanelShell>
  );
};

const LazyRightPanel = (props: { mode: DiffPanelMode; panelMode: RightPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense
        fallback={
          <RightPanelLoadingFallback
            mode={props.mode}
            label={
              props.panelMode === "diff" ? "Loading diff viewer..." : "Loading file preview..."
            }
          />
        }
      >
        {props.panelMode === "diff" ? (
          <DiffPanel mode={props.mode} />
        ) : (
          <PreviewPanel mode={props.mode} />
        )}
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const RightPanelInlineSidebar = (props: {
  open: boolean;
  panelMode: RightPanelMode;
  onClose: () => void;
  onOpen: () => void;
  renderContent: boolean;
}) => {
  const { open, onClose, onOpen, panelMode, renderContent } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpen();
        return;
      }
      onClose();
    },
    [onClose, onOpen],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderContent ? <LazyRightPanel mode="sidebar" panelMode={panelMode} /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

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
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const diffOpen = search.diff === "1";
  const previewOpen = search.preview === "1";
  const rightPanelMode: RightPanelMode | null = getRightPanelMode(search);
  const rightPanelOpen = rightPanelMode !== null;
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
    hasOpenedPreview: previewOpen,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const hasOpenedPreview =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedPreview
      : previewOpen;
  const [lastOpenedRightPanelMode, setLastOpenedRightPanelMode] = useState<RightPanelMode>(
    () => rightPanelMode ?? "diff",
  );
  const markRightPanelOpened = useCallback(
    (panelMode: RightPanelMode) => {
      setLastOpenedRightPanelMode(panelMode);
      setDiffPanelMountState((previous) => {
        const nextState = {
          threadKey: currentThreadKey,
          hasOpenedDiff:
            (previous.threadKey === currentThreadKey ? previous.hasOpenedDiff : diffOpen) ||
            panelMode === "diff",
          hasOpenedPreview:
            (previous.threadKey === currentThreadKey ? previous.hasOpenedPreview : previewOpen) ||
            panelMode === "preview",
        };
        if (
          previous.threadKey === nextState.threadKey &&
          previous.hasOpenedDiff === nextState.hasOpenedDiff &&
          previous.hasOpenedPreview === nextState.hasOpenedPreview
        ) {
          return previous;
        }
        return nextState;
      });
    },
    [currentThreadKey, diffOpen, previewOpen],
  );
  const closeRightPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => closeRightPanelSearch(previous),
    });
  }, [navigate, threadRef]);
  const openDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markRightPanelOpened("diff");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => buildOpenDiffSearch(previous),
    });
  }, [markRightPanelOpened, navigate, threadRef]);
  const openPreview = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markRightPanelOpened("preview");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => buildOpenPreviewSearch(previous),
    });
  }, [markRightPanelOpened, navigate, threadRef]);
  const openRightPanel = useCallback(() => {
    if (lastOpenedRightPanelMode === "preview") {
      openPreview();
      return;
    }
    openDiff();
  }, [lastOpenedRightPanelMode, openDiff, openPreview]);

  useEffect(() => {
    if (rightPanelMode !== null) {
      setLastOpenedRightPanelMode(rightPanelMode);
    }
  }, [rightPanelMode]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderRightPanelContent =
    rightPanelMode === "diff" || hasOpenedDiff || rightPanelMode === "preview" || hasOpenedPreview;
  const mountedRightPanelMode: RightPanelMode = rightPanelMode ?? lastOpenedRightPanelMode;

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-dvh  min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            onDiffPanelOpen={() => markRightPanelOpened("diff")}
            onPreviewPanelOpen={() => markRightPanelOpened("preview")}
            reserveTitleBarControlInset={!rightPanelOpen}
            routeKind="server"
          />
        </SidebarInset>
        <RightPanelInlineSidebar
          open={rightPanelOpen}
          panelMode={mountedRightPanelMode}
          onClose={closeRightPanel}
          onOpen={openRightPanel}
          renderContent={shouldRenderRightPanelContent}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          onDiffPanelOpen={() => markRightPanelOpened("diff")}
          onPreviewPanelOpen={() => markRightPanelOpened("preview")}
          routeKind="server"
        />
      </SidebarInset>
      <RightPanelSheet open={rightPanelOpen} onClose={closeRightPanel}>
        {shouldRenderRightPanelContent ? (
          <LazyRightPanel mode="sheet" panelMode={mountedRightPanelMode} />
        ) : null}
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseRightPanelRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<RightPanelRouteSearch>(["diff", "preview"])],
  },
  component: ChatThreadRouteView,
});
