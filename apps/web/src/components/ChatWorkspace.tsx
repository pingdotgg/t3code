import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { XIcon } from "lucide-react";

import {
  chatWorkspaceTargetKey,
  useChatWorkspaceStore,
  type ChatWorkspacePane,
  type ChatWorkspaceTarget,
} from "../chatWorkspaceStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProject, useThread } from "../state/entities";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import ChatView from "./ChatView";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { SidebarInset } from "./ui/sidebar";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "~/lib/utils";

export interface ChatWorkspacePaneRenderOptions {
  readonly paneId: string;
  readonly target: ChatWorkspaceTarget;
  readonly paneIndex: number;
  readonly paneCount: number;
  readonly isActivePane: boolean;
  readonly onClosePane: () => void;
}

interface ChatWorkspaceProps {
  readonly activeTarget: ChatWorkspaceTarget;
  readonly renderActivePane: (options: ChatWorkspacePaneRenderOptions) => ReactNode;
}

function navigateToTarget(
  navigate: ReturnType<typeof useNavigate>,
  target: ChatWorkspaceTarget,
): void {
  if (target.kind === "server") {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target.threadRef),
      replace: true,
    });
    return;
  }
  void navigate({
    to: "/draft/$draftId",
    params: buildDraftThreadRouteParams(target.draftId),
    replace: true,
  });
}

function WorkspaceDraftPane({
  pane,
  paneIndex,
  paneCount,
  isActivePane,
  onClosePane,
}: {
  readonly pane: ChatWorkspacePane;
  readonly paneIndex: number;
  readonly paneCount: number;
  readonly isActivePane: boolean;
  readonly onClosePane: () => void;
}) {
  const draftId = pane.target.kind === "draft" ? pane.target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );

  if (!draftId || !draftSession) {
    return null;
  }

  return (
    <ChatView
      paneId={pane.id}
      paneIndex={paneIndex}
      paneCount={paneCount}
      isActivePane={isActivePane}
      onClosePane={onClosePane}
      draftId={draftId}
      environmentId={draftSession.environmentId}
      threadId={draftSession.threadId}
      routeKind="draft"
    />
  );
}

function WorkspaceServerPane({
  pane,
  paneIndex,
  paneCount,
  isActivePane,
  onClosePane,
}: {
  readonly pane: ChatWorkspacePane;
  readonly paneIndex: number;
  readonly paneCount: number;
  readonly isActivePane: boolean;
  readonly onClosePane: () => void;
}) {
  if (pane.target.kind !== "server") {
    return null;
  }

  return (
    <ChatView
      paneId={pane.id}
      paneIndex={paneIndex}
      paneCount={paneCount}
      isActivePane={isActivePane}
      onClosePane={onClosePane}
      environmentId={pane.target.threadRef.environmentId}
      threadId={pane.target.threadRef.threadId}
      routeKind="server"
    />
  );
}

function PaneResizeHandle({
  splitRatio,
  isResizing,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onNudge,
}: {
  readonly splitRatio: number;
  readonly isResizing: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onNudge: (delta: number) => void;
}) {
  const percentage = Math.round(splitRatio * 100);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onNudge(-0.02);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onNudge(0.02);
    }
  };

  return (
    <div
      role="separator"
      aria-label="Resize chat panes"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={percentage}
      aria-valuetext={`${percentage}% for the left pane`}
      tabIndex={0}
      className={cn(
        "group absolute inset-y-0 right-0 z-40 w-2 cursor-col-resize touch-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/70",
        isResizing && "bg-primary/10",
      )}
      onKeyDown={handleKeyDown}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 right-1/2 w-0.5 translate-x-1/2 rounded-full bg-border/70 transition-colors group-hover:bg-primary/70",
          isResizing && "bg-primary",
        )}
      />
    </div>
  );
}

function PaneTab({
  pane,
  paneIndex,
  isActivePane,
  onActivate,
  onClose,
}: {
  readonly pane: ChatWorkspacePane;
  readonly paneIndex: number;
  readonly isActivePane: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const threadRef = pane.target.kind === "server" ? pane.target.threadRef : null;
  const thread = useThread(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const fallbackTitle =
    pane.target.kind === "draft"
      ? "New draft"
      : `Thread ${String(pane.target.threadRef.threadId).slice(0, 8)}`;
  const title = thread?.title || fallbackTitle;
  const projectTitle = project?.title ?? null;

  return (
    <div
      role="group"
      aria-label={`Pane ${paneIndex}: ${title}`}
      className={cn(
        "flex min-w-0 max-w-72 shrink-0 items-center rounded-md border text-xs transition-colors",
        isActivePane
          ? "border-primary/45 bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <button
        type="button"
        aria-pressed={isActivePane}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-s-md px-2 py-1.5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
        onClick={onActivate}
        title={`${title}${projectTitle ? ` · ${projectTitle}` : ""}`}
      >
        <span
          aria-hidden
          className={cn(
            "inline-flex size-4.5 shrink-0 items-center justify-center rounded border text-[10px] font-semibold tabular-nums",
            isActivePane
              ? "border-primary/45 bg-primary/15 text-primary"
              : "border-border/70 bg-muted/60 text-muted-foreground",
          )}
        >
          {paneIndex}
        </span>
        <span className="min-w-0 truncate font-medium">{title}</span>
        {projectTitle ? (
          <span className="hidden min-w-0 truncate text-muted-foreground @2xl/workspace-tabs:inline">
            · {projectTitle}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Close pane ${paneIndex}`}
        className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
        onClick={onClose}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  );
}

function PaneStrip({
  panes,
  activePaneId,
  onActivate,
  onClose,
}: {
  readonly panes: ReadonlyArray<ChatWorkspacePane>;
  readonly activePaneId: string;
  readonly onActivate: (pane: ChatWorkspacePane) => void;
  readonly onClose: (pane: ChatWorkspacePane) => void;
}) {
  return (
    <div className="@container/workspace-tabs flex min-h-10 min-w-0 shrink-0 items-center border-b border-border/60 bg-muted/20 px-2">
      <div
        role="toolbar"
        aria-label="Open chat panes"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {panes.map((pane, index) => (
          <PaneTab
            key={pane.id}
            pane={pane}
            paneIndex={index + 1}
            isActivePane={pane.id === activePaneId}
            onActivate={() => onActivate(pane)}
            onClose={() => onClose(pane)}
          />
        ))}
      </div>
      <span className="hidden shrink-0 px-2 text-[11px] text-muted-foreground @2xl/workspace-tabs:inline">
        {panes.length} {panes.length === 1 ? "pane" : "panes"}
      </span>
    </div>
  );
}

function PaneFrame({
  pane,
  paneIndex,
  paneCount,
  isActivePane,
  onActivate,
  children,
}: {
  readonly pane: ChatWorkspacePane;
  readonly paneIndex: number;
  readonly paneCount: number;
  readonly isActivePane: boolean;
  readonly onActivate: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={`Chat pane ${paneIndex} of ${paneCount}`}
      data-chat-pane="true"
      data-chat-pane-active={isActivePane ? "true" : "false"}
      data-chat-pane-id={pane.id}
      className={cn(
        "relative flex min-h-0 min-w-0 overflow-hidden border border-border/50 transition-[border-color,box-shadow] duration-150 [&+section]:border-l-2",
        isActivePane
          ? "border-primary/55 ring-1 ring-inset ring-primary/45"
          : "ring-1 ring-inset ring-transparent hover:border-border hover:ring-border/60",
      )}
      onFocusCapture={onActivate}
      onPointerDown={onActivate}
    >
      {children}
    </section>
  );
}

export function ChatWorkspace({ activeTarget, renderActivePane }: ChatWorkspaceProps) {
  const navigate = useNavigate();
  const panes = useChatWorkspaceStore((state) => state.panes);
  const storedActivePaneId = useChatWorkspaceStore((state) => state.activePaneId);
  const splitRatio = useChatWorkspaceStore((state) => state.splitRatio);
  const reconcileRouteTarget = useChatWorkspaceStore((state) => state.reconcileRouteTarget);
  const focusPane = useChatWorkspaceStore((state) => state.focusPane);
  const closePane = useChatWorkspaceStore((state) => state.closePane);
  const setSplitRatio = useChatWorkspaceStore((state) => state.setSplitRatio);
  const activeTargetKey = chatWorkspaceTargetKey(activeTarget);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const resizeStartRef = useRef<{
    readonly startX: number;
    readonly startRatio: number;
    readonly width: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const isWideEnoughForSplit = useMediaQuery("md");

  useEffect(() => {
    reconcileRouteTarget(activeTarget);
  }, [activeTargetKey, activeTarget, reconcileRouteTarget]);

  const visiblePanes: ReadonlyArray<ChatWorkspacePane> =
    panes.length === 0
      ? [{ id: activeTargetKey, target: activeTarget }]
      : panes.some((pane) => pane.id === activeTargetKey)
        ? panes
        : panes.map((pane) =>
            pane.id === (storedActivePaneId ?? panes[0]?.id)
              ? { id: activeTargetKey, target: activeTarget }
              : pane,
          );
  const activePaneId = visiblePanes.some((pane) => pane.id === activeTargetKey)
    ? activeTargetKey
    : (storedActivePaneId ?? activeTargetKey);
  const isResizable = visiblePanes.length === 2 && isWideEnoughForSplit;

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isResizable) return;
      const width = gridRef.current?.getBoundingClientRect().width ?? 0;
      if (width <= 0) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStartRef.current = {
        startX: event.clientX,
        startRatio: splitRatio,
        width,
      };
      setIsResizing(true);
    },
    [isResizable, splitRatio],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeStart = resizeStartRef.current;
      if (!resizeStart) return;
      setSplitRatio(
        resizeStart.startRatio + (event.clientX - resizeStart.startX) / resizeStart.width,
      );
    },
    [setSplitRatio],
  );

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeStartRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeStartRef.current = null;
    setIsResizing(false);
  }, []);

  const nudgeSplitRatio = useCallback(
    (delta: number) => {
      setSplitRatio(splitRatio + delta);
    },
    [setSplitRatio, splitRatio],
  );

  const activatePane = useCallback(
    (pane: ChatWorkspacePane) => {
      focusPane(pane.id);
      if (pane.id !== activePaneId) {
        navigateToTarget(navigate, pane.target);
      }
    },
    [activePaneId, focusPane, navigate],
  );

  const handleClosePane = useCallback(
    (pane: ChatWorkspacePane) => {
      const wasActive = pane.id === activePaneId;
      closePane(pane.id);
      if (!wasActive) return;

      const nextState = useChatWorkspaceStore.getState();
      const nextPane = nextState.panes.find((candidate) => candidate.id === nextState.activePaneId);
      if (nextPane) {
        navigateToTarget(navigate, nextPane.target);
      } else {
        void navigate({ to: "/", replace: true });
      }
    },
    [activePaneId, closePane, navigate],
  );

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <DiffWorkerPoolProvider>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {visiblePanes.length > 1 ? (
            <PaneStrip
              panes={visiblePanes}
              activePaneId={activePaneId}
              onActivate={activatePane}
              onClose={handleClosePane}
            />
          ) : null}
          <div
            ref={gridRef}
            data-chat-workspace-split={isResizable ? "true" : "false"}
            className={cn(
              "grid min-h-0 min-w-0 flex-1 overflow-auto bg-background",
              isResizing && "select-none",
            )}
            style={{
              gridTemplateColumns: isResizable
                ? `minmax(280px, ${splitRatio}fr) minmax(280px, ${1 - splitRatio}fr)`
                : "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
              gridAutoRows: "minmax(0, 1fr)",
            }}
          >
            {visiblePanes.map((pane, paneOffset) => {
              const paneIndex = paneOffset + 1;
              const paneCount = visiblePanes.length;
              const isActivePane = pane.id === activePaneId;
              const onActivate = () => activatePane(pane);
              const onClose = () => handleClosePane(pane);
              const content =
                pane.id === activeTargetKey
                  ? renderActivePane({
                      paneId: pane.id,
                      target: pane.target,
                      paneIndex,
                      paneCount,
                      isActivePane,
                      onClosePane: onClose,
                    })
                  : pane.target.kind === "draft"
                    ? (
                        <WorkspaceDraftPane
                          pane={pane}
                          paneIndex={paneIndex}
                          paneCount={paneCount}
                          isActivePane={isActivePane}
                          onClosePane={onClose}
                        />
                      )
                    : (
                        <WorkspaceServerPane
                          pane={pane}
                          paneIndex={paneIndex}
                          paneCount={paneCount}
                          isActivePane={isActivePane}
                          onClosePane={onClose}
                        />
                      );
              return (
                <PaneFrame
                  key={pane.id}
                  pane={pane}
                  paneIndex={paneIndex}
                  paneCount={paneCount}
                  isActivePane={isActivePane}
                  onActivate={onActivate}
                >
                  {content}
                  {isResizable && paneOffset === 0 ? (
                    <PaneResizeHandle
                      splitRatio={splitRatio}
                      isResizing={isResizing}
                      onNudge={nudgeSplitRatio}
                      onPointerCancel={finishResize}
                      onPointerDown={handleResizePointerDown}
                      onPointerMove={handleResizePointerMove}
                      onPointerUp={finishResize}
                    />
                  ) : null}
                </PaneFrame>
              );
            })}
          </div>
        </div>
      </DiffWorkerPoolProvider>
    </SidebarInset>
  );
}
