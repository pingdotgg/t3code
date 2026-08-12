import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useDraggable } from "@dnd-kit/core";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
  TurnId,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { ChevronsDownUpIcon, GripVerticalIcon, Maximize2Icon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  cardSizeForHeight,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  clampCardHeight,
  selectCardHeight,
  useBoardCardStore,
} from "../../board/boardCardStore.ts";
import type { BoardLane, BoardLaneId } from "../../board/boardLaneStore.ts";
import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
import { useDiffPanelStore } from "../../diffPanelStore.ts";
import { useRightPanelStore } from "../../rightPanelStore.ts";
import { useTheme } from "../../hooks/useTheme.ts";
import { ensureLocalApi } from "../../localApi.ts";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "../../session-logic.ts";
import { readProject, useServerConfigs, useThread } from "../../state/entities.ts";
import { useUiStateStore } from "../../uiStateStore.ts";
import { useThreadContextMenu } from "../useThreadContextMenu.ts";
import {
  resolveThreadRuntimeState,
  threadRuntimeStateAppearance,
  type ThreadRuntimeState,
} from "../../state/threadRuntimeState.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import { useThreadTimeline } from "../chat/useThreadTimeline.ts";
import { ChatComposer } from "../chat/ChatComposer.tsx";
import { useBoardThreadComposer } from "../chat/useThreadComposer.ts";
import { Button } from "../ui/button.tsx";
import { toastManager } from "../ui/toast.tsx";
import { BoardCardExpandedSheet } from "./BoardCardExpandedSheet.tsx";
import { useInViewport } from "./useInViewport.ts";
import { MessagesTimeline } from "../chat/MessagesTimeline.tsx";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog.tsx";
import { type ExpandedImagePreview } from "../chat/ExpandedImagePreview.tsx";

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const NOOP = () => {};

export interface BoardSessionCardProps {
  readonly cardKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly laneId: BoardLaneId;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly projectTitle: string;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly isDragging: boolean;
}

export const BoardSessionCard = memo(function BoardSessionCard(props: BoardSessionCardProps) {
  const {
    cardKey,
    threadRef,
    thread,
    laneId,
    lanes,
    projectTitle,
    environmentLabel,
    environmentConnection,
  } = props;

  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const { openThreadContextMenu } = useThreadContextMenu({
    onMarkUnread: markThreadUnread,
  });

  const setHeight = useBoardCardStore((state) => state.setHeight);
  const setSize = useBoardCardStore((state) => state.setSize);
  const heightPx = useBoardCardStore((state) => selectCardHeight(state.byThreadKey, threadRef));
  // Expansion and focus live on the board's shared store, not on the card: the
  // sidebar opens and points at cards too, and there is only ever one of each.
  const expanded = useBoardFocusStore((state) => state.expandedThreadKey === cardKey);
  const isFocused = useBoardFocusStore((state) => state.focusedThreadKey === cardKey);
  const focusRequestNonce = useBoardFocusStore((state) =>
    state.request?.threadKey === cardKey ? state.request.nonce : null,
  );
  const setExpandedKey = useBoardFocusStore((state) => state.setExpanded);
  const setFocusedKey = useBoardFocusStore((state) => state.setFocused);
  const setExpanded = useCallback(
    (open: boolean) => setExpandedKey(open ? cardKey : null),
    [cardKey, setExpandedKey],
  );

  const slotRef = useRef<HTMLDivElement | null>(null);
  const isNearViewport = useInViewport(slotRef, {
    rootMargin: "300px",
  });

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging: isDraggingSelf,
  } = useDraggable({
    id: cardKey,
  });

  const status = resolveThreadRuntimeState(thread);
  const appearance = threadRuntimeStateAppearance(status);

  const [draggingHeight, setDraggingHeight] = useState<number | null>(null);
  const teardownResizeRef = useRef<(() => void) | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      teardownResizeRef.current?.();
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    },
    [],
  );

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startHeight = heightPx;
      let latest = startHeight;
      const pointerId = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // Window listeners below keep resizing functional without pointer capture.
      }

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        latest = clampCardHeight(startHeight + (moveEvent.clientY - startY));
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          setDraggingHeight(latest);
        });
      };
      const finish = (finishEvent: PointerEvent) => {
        if (finishEvent.pointerId !== pointerId) return;
        teardownResizeRef.current?.();
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        setDraggingHeight(null);
        setHeight(threadRef, latest);
      };
      const teardown = () => {
        teardownResizeRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };

      teardownResizeRef.current = teardown;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [heightPx, setHeight, threadRef],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 50 : 10;
      const next =
        event.key === "ArrowUp"
          ? heightPx - step
          : event.key === "ArrowDown"
            ? heightPx + step
            : event.key === "Home"
              ? CARD_MIN_HEIGHT
              : event.key === "End"
                ? CARD_MAX_HEIGHT
                : null;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      setHeight(threadRef, next);
    },
    [heightPx, setHeight, threadRef],
  );

  const effectiveHeight = draggingHeight ?? heightPx;
  const size = cardSizeForHeight(effectiveHeight);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const threadProject = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
      const workspacePath = thread.worktreePath ?? threadProject?.workspaceRoot ?? null;
      void openThreadContextMenu(
        {
          threadRef,
          thread,
          workspacePath,
          lanes,
        },
        { x: event.clientX, y: event.clientY },
      );
    },
    [lanes, openThreadContextMenu, thread, threadRef],
  );

  return (
    <div
      ref={slotRef}
      data-board-card={thread.id}
      data-board-card-key={cardKey}
      data-lane={laneId ?? "unknown"}
      onPointerDownCapture={() => setFocusedKey(cardKey)}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
    >
      <div
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm",
          isFocused && "border-primary/60 ring-1 ring-primary/40",
          (isDraggingSelf || props.isDragging) && "opacity-60",
        )}
        style={{ height: `${effectiveHeight}px` }}
        onContextMenu={handleContextMenu}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 top-0 z-10 h-0.5",
            appearance.accentClass,
            appearance.pulse && "animate-status-pulse motion-reduce:animate-none",
          )}
        />
        <header className="flex shrink-0 items-start gap-1.5 border-b border-border/60 px-2 py-1.5">
          <button
            type="button"
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            aria-label={`Drag ${thread.title}`}
            className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground active:cursor-grabbing pointer-coarse:p-1.5"
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium leading-4" title={thread.title}>
              {thread.title}
            </p>
            <p className="truncate text-[10px] text-muted-foreground/60">
              {projectTitle}
              {thread.branch ? ` · ${thread.branch}` : ""}
            </p>
            <p
              className="truncate text-[10px] text-muted-foreground/60"
              title={`${environmentLabel} · ${environmentConnection.phase}`}
            >
              {environmentLabel}
              {environmentConnection.phase === "connected"
                ? ""
                : ` · ${environmentConnection.phase}`}
            </p>
          </div>
          <StatusDot status={status} />
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setSize(threadRef, size === "tall" ? "compact" : "tall")}
            aria-label={size === "tall" ? "Make card compact" : "Make card tall"}
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <ChevronsDownUpIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setExpanded(true)}
            aria-label="Zoom into session"
            data-testid={`board-card-zoom-${thread.id}`}
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <Maximize2Icon className="size-3.5" />
          </Button>
        </header>

        {(isNearViewport || isFocused) && !expanded ? (
          <BoardCardChatSurface
            cardKey={cardKey}
            cardElementRef={slotRef}
            threadRef={threadRef}
            thread={thread}
            environmentLabel={environmentLabel}
            environmentConnection={environmentConnection}
            focusRequestNonce={focusRequestNonce}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[10px] text-muted-foreground/50">
            Scroll into view to connect
          </div>
        )}

        <button
          type="button"
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${thread.title} card. Use arrow keys to resize.`}
          aria-valuemin={CARD_MIN_HEIGHT}
          aria-valuemax={CARD_MAX_HEIGHT}
          aria-valuenow={effectiveHeight}
          data-testid={`board-card-resize-${thread.id}`}
          className="h-2 shrink-0 cursor-ns-resize touch-none border-0 border-t border-border/40 bg-transparent p-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-6"
        />
      </div>

      <BoardCardExpandedSheet
        threadRef={threadRef}
        title={thread.title}
        open={expanded}
        onOpenChange={setExpanded}
      />
    </div>
  );
});

const BoardCardChatSurface = memo(function BoardCardChatSurface({
  cardKey,
  cardElementRef,
  threadRef,
  thread,
  environmentLabel,
  environmentConnection,
  focusRequestNonce,
}: {
  readonly cardKey: string;
  readonly cardElementRef: React.RefObject<HTMLDivElement | null>;
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly focusRequestNonce: number | null;
}) {
  const fullThread = useThread(threadRef);
  const serverConfigs = useServerConfigs();
  const { resolvedTheme } = useTheme();
  const legendListRef = useRef<LegendListRef | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });

  const providerStatuses = useMemo<ReadonlyArray<ServerProvider>>(
    () => serverConfigs.get(threadRef.environmentId)?.providers ?? [],
    [serverConfigs, threadRef.environmentId],
  );

  const activities = fullThread?.activities ?? [];
  const timelineMessages = fullThread?.messages ?? [];

  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      if (!fullThread || isRevertingCheckpoint) {
        return;
      }
      if (environmentConnection.phase !== "connected") {
        toastManager.add({
          type: "warning",
          title: `Reconnect ${environmentLabel}`,
          description: "Reconnect this environment before reverting checkpoints.",
        });
        return;
      }
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        toastManager.add({
          type: "warning",
          title: "Session is working",
          description: "Interrupt the current turn before reverting checkpoints.",
        });
        return;
      }
      const confirmed = await ensureLocalApi().dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      const result = await revertThreadCheckpoint({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.error(error instanceof Error ? error.message : "Failed to revert thread state.");
      }
      setIsRevertingCheckpoint(false);
    },
    [
      environmentConnection.phase,
      environmentLabel,
      fullThread,
      isRevertingCheckpoint,
      revertThreadCheckpoint,
      thread.session?.status,
      threadRef,
    ],
  );

  const {
    timelineEntries,
    latestTurn,
    runningTurnId,
    isWorking,
    activeTurnInProgress,
    activeTurnStartedAt,
    turnDiffSummaryByAssistantMessageId,
    revertTurnCountByUserMessageId,
    onRevertUserMessage,
    markdownCwd,
    workspaceRoot,
    resolvedTheme: timelineTheme,
    timestampFormat,
    skills,
    routeThreadKey,
    activeThreadEnvironmentId,
    isRevertingCheckpoint: timelineIsRevertingCheckpoint,
  } = useThreadTimeline({
    threadRef,
    thread: fullThread,
    timelineMessages,
    isRevertingCheckpoint,
    onRevertToTurnCount,
    resolvedTheme,
    skills: providerSkills(providerStatuses, thread) ?? EMPTY_SKILLS,
  });

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      useDiffPanelStore.getState().selectTurn(threadRef, turnId, filePath);
      useRightPanelStore.getState().open(threadRef, "diff");
    },
    [threadRef],
  );

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);

  const { chatComposerProps, composerRef } = useBoardThreadComposer({
    threadRef,
    thread: fullThread,
    summary: thread,
    environmentLabel,
    environmentConnection,
    resolvedTheme,
    onExpandImage: onExpandTimelineImage,
  });
  const acknowledgeFocus = useBoardFocusStore((state) => state.acknowledgeFocus);

  useEffect(() => {
    if (focusRequestNonce === null) return;
    const frame = window.requestAnimationFrame(() => {
      composerRef.current?.focusAtEnd();
      const activeElement = document.activeElement;
      if (activeElement !== null && cardElementRef.current?.contains(activeElement)) {
        acknowledgeFocus(cardKey, focusRequestNonce);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [acknowledgeFocus, cardElementRef, cardKey, composerRef, focusRequestNonce]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline
          density="compact"
          viewportClassName="pointer-coarse:overflow-y-hidden pointer-coarse:overscroll-y-auto pointer-coarse:touch-pan-y"
          isWorking={isWorking}
          activeTurnInProgress={activeTurnInProgress}
          activeTurnStartedAt={activeTurnStartedAt}
          listRef={legendListRef}
          timelineEntries={timelineEntries}
          latestTurn={latestTurn}
          runningTurnId={runningTurnId}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
          onRevertUserMessage={onRevertUserMessage}
          isRevertingCheckpoint={timelineIsRevertingCheckpoint}
          onImageExpand={onExpandTimelineImage}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          markdownCwd={markdownCwd}
          resolvedTheme={timelineTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          skills={skills}
          anchorMessageId={null}
          onAnchorReady={NOOP}
          onAnchorSizeChanged={NOOP}
          contentInsetEndAdjustment={0}
          onIsAtEndChange={NOOP}
          onManualNavigation={NOOP}
          hideEmptyPlaceholder={false}
          topFadeEnabled={false}
        />
      </div>

      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}

      <AttentionStrip
        pendingApprovals={pendingApprovals}
        pendingUserInputs={pendingUserInputs}
        onOpen={() => useBoardFocusStore.getState().setExpanded(cardKey)}
      />

      <div className="shrink-0 border-t border-border/60 px-1.5 py-1">
        <ChatComposer {...chatComposerProps} />
      </div>
    </>
  );
});

function providerSkills(
  providerStatuses: ReadonlyArray<ServerProvider>,
  thread: SidebarThreadSummary,
): ReadonlyArray<ServerProviderSkill> | null {
  const instanceId = thread.modelSelection.instanceId;
  const match = providerStatuses.find((provider) => provider.instanceId === instanceId);
  return match?.skills ?? null;
}

function AttentionStrip({
  pendingApprovals,
  pendingUserInputs,
  onOpen,
}: {
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly onOpen: () => void;
}) {
  const approval = pendingApprovals[0];
  const question = pendingUserInputs[0];

  if (!approval && !question) return null;

  // Approval and input are different states in the app's color language
  // (amber vs indigo); when both are pending, approval outranks input the
  // same way resolveThreadRuntimeState does.
  const attentionTextClass = threadRuntimeStateAppearance(
    approval ? "approval" : "input",
  ).textClass;

  return (
    <div
      data-testid="board-card-attention"
      className="shrink-0 space-y-1.5 border-t border-border/60 bg-muted/40 px-2 py-1.5"
    >
      <p className={cn("text-[10px] font-medium", attentionTextClass)}>
        {approval
          ? `Approval needed · ${approval.requestKind}`
          : `${question?.questions.length ?? 0} ${(question?.questions.length ?? 0) === 1 ? "question" : "questions"} waiting`}
      </p>
      <p className="text-[10px] text-muted-foreground">
        Open the full session to respond with the standard approval and answer controls.
      </p>
      <Button size="xs" variant="outline" onClick={onOpen}>
        Review request
      </Button>
    </div>
  );
}

// Matches resolveThreadStatusPill's colorClass for the same states (Sidebar.logic.ts)
// so the strip's headings read the same hue as the sidebar pill for approval/input.
function StatusDot({ status }: { readonly status: ThreadRuntimeState }) {
  const appearance = threadRuntimeStateAppearance(status);
  return (
    <span
      data-testid="board-card-status"
      data-status={status}
      title={appearance.label}
      className={cn(
        "mt-1 size-1.5 shrink-0 rounded-full",
        appearance.accentClass,
        appearance.pulse && "animate-status-pulse motion-reduce:animate-none",
      )}
    />
  );
}
