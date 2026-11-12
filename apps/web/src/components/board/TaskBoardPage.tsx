import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useResizeDrag } from "../../hooks/useResizeDrag";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadRenameInput } from "../sidebar/SidebarThreadRow";
import { showThreadContextMenu } from "../sidebar/threadContextMenu";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  BOARD_PANELS,
  BOARD_COLUMN_WIDTH,
  BoardLayoutSchema,
  boardColumnWidth,
  setBoardColumnWidth,
  boardPanelWeight,
  groupThreadsByPanel,
  moveBoardPanel,
  resetBoardColumnWeights,
  resolveBoardDropEdge,
  resolveBoardKeyboardMove,
  resolveBoardLayout,
  setBoardPanelWeights,
  splitBoardPanelPair,
  toggleBoardPanelCollapsed,
  type BoardPanelPair,
  type BoardDropEdge,
  type BoardLayout,
  type BoardMoveDirection,
  type BoardPanelId,
} from "./taskBoard.logic";

const PAGE_SIZE = 50;
const MOVE_KEYS: Partial<Record<string, BoardMoveDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};
const LAYOUT_STORAGE_KEY = "t3code:task-board:layout";
const SavedLayoutSchema = Schema.NullOr(BoardLayoutSchema);
const PANEL_LABELS = new Map(BOARD_PANELS.map((panel) => [panel.id, panel.label]));
const RESIZE_KEY_STEP = 16;

type DropTarget = { readonly panelId: BoardPanelId; readonly edge: BoardDropEdge };
type PanelMode = "expanded" | "header" | "rail";

const DROP_EDGE_CLASS: Record<BoardDropEdge, string> = {
  left: "inset-y-0 -left-2 w-1",
  right: "inset-y-0 -right-2 w-1",
  top: "inset-x-0 -top-2 h-1",
  bottom: "inset-x-0 -bottom-2 h-1",
};

const cardKey = (thread: SidebarThreadSummary) => `${thread.environmentId}:${thread.id}`;

interface BoardCardHandlers {
  onOpen: (thread: SidebarThreadSummary) => void;
  onStartRename: (key: string) => void;
  onCommitRename: (thread: SidebarThreadSummary, title: string) => void;
  onCancelRename: () => void;
}

// Mounted only while renaming, so the draft starts from the current title.
function BoardCardRename(props: {
  thread: SidebarThreadSummary;
  onCommit: (thread: SidebarThreadSummary, title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(props.thread.title);
  return (
    <div className="flex w-full rounded-lg border border-border bg-card px-3 py-2">
      <ThreadRenameInput
        title={title}
        onTitleChange={setTitle}
        onCommit={() => props.onCommit(props.thread, title)}
        onCancel={props.onCancel}
      />
    </div>
  );
}

const BoardCard = memo(function BoardCard(
  props: BoardCardHandlers & {
    thread: SidebarThreadSummary;
    projectTitle: string | null;
    nowMs: number;
    renaming: boolean;
  },
) {
  const { thread, onStartRename } = props;
  const pill = resolveThreadStatusPill({ thread });
  const openMenu = (position: { x: number; y: number }) =>
    showThreadContextMenu(scopeThreadRef(thread.environmentId, thread.id), position, {
      onStartRename: () => onStartRename(cardKey(thread)),
    });
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (openMenu({ x: event.clientX, y: event.clientY })) event.preventDefault();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (openMenu({ x: rect.left, y: rect.bottom })) event.preventDefault();
  };
  if (props.renaming) {
    return (
      <BoardCardRename
        thread={thread}
        onCommit={props.onCommitRename}
        onCancel={props.onCancelRename}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => props.onOpen(thread)}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      className="flex w-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="line-clamp-2 text-sm font-medium text-foreground">{thread.title}</span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {pill ? (
          <span className={`inline-flex shrink-0 items-center gap-1 ${pill.colorClass}`}>
            <span className={`size-1.5 rounded-full ${pill.dotClass}`} />
            {pill.label}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{props.projectTitle}</span>
        <span className="shrink-0">{formatRelativeTimeLabel(thread.updatedAt, props.nowMs)}</span>
      </span>
    </button>
  );
});

// Kept apart from the panel shell so drag feedback never re-renders the cards.
const BoardPanelCards = memo(function BoardPanelCards(
  props: BoardCardHandlers & {
    panelId: BoardPanelId;
    items: SidebarThreadSummary[];
    limit: number;
    renamingKey: string | null;
    projectTitles: ReadonlyMap<string, string>;
    nowMs: number;
    onShowMore: (panelId: BoardPanelId) => void;
  },
) {
  const { items, limit } = props;
  return (
    // Horizontal wheel movement must chain to the board, so only the y axis is contained.
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <div className="flex flex-col gap-2 px-2 pb-2">
        {items.slice(0, limit).map((thread) => (
          <BoardCard
            key={cardKey(thread)}
            thread={thread}
            projectTitle={
              props.projectTitles.get(`${thread.environmentId}:${thread.projectId}`) ?? null
            }
            nowMs={props.nowMs}
            renaming={props.renamingKey === cardKey(thread)}
            onOpen={props.onOpen}
            onStartRename={props.onStartRename}
            onCommitRename={props.onCommitRename}
            onCancelRename={props.onCancelRename}
          />
        ))}
        {items.length > limit ? (
          <button
            type="button"
            onClick={() => props.onShowMore(props.panelId)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Show {Math.min(PAGE_SIZE, items.length - limit)} more
          </button>
        ) : null}
      </div>
    </div>
  );
});

function BoardPanelHeader(props: {
  panelId: BoardPanelId;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: (panelId: BoardPanelId) => void;
}) {
  const { listeners, setNodeRef } = useDraggable({ id: props.panelId });
  const ToggleIcon = props.collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className="flex shrink-0 cursor-grab touch-none items-center gap-2 py-1.5 pr-1.5 pl-3 active:cursor-grabbing"
    >
      <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground uppercase">
        {props.label}
      </h2>
      <span className="text-xs text-muted-foreground">{props.count}</span>
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label={props.collapsed ? `Expand ${props.label}` : `Collapse ${props.label}`}
        aria-expanded={!props.collapsed}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
        onClick={() => props.onToggle(props.panelId)}
      >
        <ToggleIcon />
      </Button>
    </div>
  );
}

function BoardPanelRail(props: {
  panelId: BoardPanelId;
  label: string;
  count: number;
  onToggle: (panelId: BoardPanelId) => void;
}) {
  const { listeners, setNodeRef } = useDraggable({ id: props.panelId });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      type="button"
      aria-label={`Expand ${props.label}`}
      aria-expanded={false}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
      onClick={() => props.onToggle(props.panelId)}
      className="flex min-h-0 flex-1 touch-none flex-col items-center gap-2 rounded-xl py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <PanelLeftOpenIcon className="size-3.5 shrink-0" />
      <span className="min-h-0 truncate text-xs font-semibold uppercase [writing-mode:vertical-rl]">
        {props.label} · {props.count}
      </span>
    </button>
  );
}

const BoardPanel = memo(function BoardPanel(
  props: BoardCardHandlers & {
    panelId: BoardPanelId;
    label: string;
    mode: PanelMode;
    items: SidebarThreadSummary[];
    limit: number;
    renamingKey: string | null;
    dragging: boolean;
    dropEdge: BoardDropEdge | null;
    projectTitles: ReadonlyMap<string, string>;
    nowMs: number;
    onShowMore: (panelId: BoardPanelId) => void;
    onToggle: (panelId: BoardPanelId) => void;
    onMoveKey: (panelId: BoardPanelId, event: ReactKeyboardEvent<HTMLElement>) => void;
  },
) {
  const { panelId, label, mode, items } = props;
  return (
    <section
      aria-label={label}
      data-board-panel={panelId}
      onKeyDown={(event) => props.onMoveKey(panelId, event)}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col rounded-xl bg-muted/40",
        props.dragging && "opacity-50",
      )}
    >
      {mode === "rail" ? (
        <BoardPanelRail
          panelId={panelId}
          label={label}
          count={items.length}
          onToggle={props.onToggle}
        />
      ) : (
        <BoardPanelHeader
          panelId={panelId}
          label={label}
          count={items.length}
          collapsed={mode === "header"}
          onToggle={props.onToggle}
        />
      )}
      {mode === "expanded" ? (
        <BoardPanelCards
          panelId={panelId}
          items={items}
          limit={props.limit}
          renamingKey={props.renamingKey}
          projectTitles={props.projectTitles}
          nowMs={props.nowMs}
          onOpen={props.onOpen}
          onStartRename={props.onStartRename}
          onCommitRename={props.onCommitRename}
          onCancelRename={props.onCancelRename}
          onShowMore={props.onShowMore}
        />
      ) : null}
      {props.dropEdge ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-full bg-primary",
            DROP_EDGE_CLASS[props.dropEdge],
          )}
        />
      ) : null}
    </section>
  );
});

type PanelWeights = Partial<Record<BoardPanelId, number>>;

function BoardPanelResizeHandle(props: {
  upperId: BoardPanelId;
  lowerId: BoardPanelId;
  upperWeight: number;
  lowerWeight: number;
  onResize: (weights: PanelWeights) => void;
  onReset: (panelId: BoardPanelId) => void;
}) {
  const { upperId, lowerId, upperWeight, lowerWeight } = props;
  // The handle sits in the upper panel's frame; the lower frame is found in the same column.
  const measure = (handle: HTMLElement) => {
    const upper = handle.parentElement;
    const lower = handle
      .closest("[data-board-column]")
      ?.querySelector<HTMLElement>(`[data-board-frame="${lowerId}"]`);
    if (!upper || !lower) return null;
    const pair: BoardPanelPair = {
      upperWeight,
      lowerWeight,
      upperHeight: upper.offsetHeight,
      lowerHeight: lower.offsetHeight,
    };
    // The frame's `min-h-*` class keeps a header plus about one card visible.
    const minHeight = Number.parseFloat(getComputedStyle(upper).minHeight) || 0;
    return { upper, lower, pair, minHeight };
  };
  const commit = ([upper, lower]: readonly [number, number]) =>
    props.onResize({ [upperId]: upper, [lowerId]: lower });
  // Sizes go straight to the frames while dragging and reach state once, on release.
  const drag = useResizeDrag<HTMLDivElement>((event) => {
    const frames = measure(event.currentTarget);
    if (!frames) return null;
    const { upper, lower, pair, minHeight } = frames;
    let split: readonly [number, number] = [upperWeight, lowerWeight];
    const apply = (weights: readonly [number, number]) => {
      upper.style.flexGrow = String(weights[0]);
      lower.style.flexGrow = String(weights[1]);
    };
    return {
      width: pair.upperHeight,
      edge: "bottom",
      bounds: { min: 0, max: pair.upperHeight + pair.lowerHeight },
      resize: (height) => {
        split = splitBoardPanelPair(pair, height - pair.upperHeight, minHeight);
        apply(split);
        return height;
      },
      cleanup: (committed) => {
        if (!committed) apply([upperWeight, lowerWeight]);
      },
      finish: (_height, moved) => {
        if (moved) commit(split);
        else apply([upperWeight, lowerWeight]);
      },
    };
  });
  const handlers = {
    ref: drag.ref,
    onPointerDown: drag.onPointerDown,
    onPointerMove: drag.onPointerMove,
    onPointerUp: drag.onPointerUp,
    onPointerCancel: drag.onPointerCancel,
    onLostPointerCapture: drag.onLostPointerCapture,
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") return props.onReset(upperId);
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const frames = measure(event.currentTarget);
    if (!frames) return;
    event.preventDefault();
    const step = event.key === "ArrowUp" ? -RESIZE_KEY_STEP : RESIZE_KEY_STEP;
    commit(splitBoardPanelPair(frames.pair, step, frames.minHeight));
  };
  return (
    <div
      {...handlers}
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${PANEL_LABELS.get(upperId)} and ${PANEL_LABELS.get(lowerId)}`}
      aria-valuenow={Math.round((upperWeight * 100) / (upperWeight + lowerWeight))}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onDoubleClick={() => props.onReset(upperId)}
      onKeyDown={handleKeyDown}
      className="group absolute inset-x-0 -bottom-3 z-10 h-3 cursor-row-resize touch-none select-none outline-none"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
      />
    </div>
  );
}

function BoardColumnResizeHandle(props: {
  panelId: BoardPanelId;
  width: number;
  onResize: (panelId: BoardPanelId, width: number | null) => void;
}) {
  const { panelId, width } = props;
  // The width goes straight to the column while dragging and reaches state once, on release.
  const drag = useResizeDrag<HTMLDivElement>((event) => {
    const column = event.currentTarget.parentElement;
    if (!column) return null;
    const apply = (next: number) => {
      column.style.width = `${next}px`;
    };
    return {
      width,
      edge: "right",
      bounds: { min: BOARD_COLUMN_WIDTH.min, max: BOARD_COLUMN_WIDTH.max },
      resize: (next) => {
        apply(next);
        return next;
      },
      cleanup: (committed) => {
        if (!committed) apply(width);
      },
      finish: (next, moved) => {
        if (moved) props.onResize(panelId, next);
        else apply(width);
      },
    };
  });
  const handlers = {
    ref: drag.ref,
    onPointerDown: drag.onPointerDown,
    onPointerMove: drag.onPointerMove,
    onPointerUp: drag.onPointerUp,
    onPointerCancel: drag.onPointerCancel,
    onLostPointerCapture: drag.onLostPointerCapture,
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") return props.onResize(panelId, null);
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    props.onResize(
      panelId,
      width + (event.key === "ArrowLeft" ? -RESIZE_KEY_STEP : RESIZE_KEY_STEP),
    );
  };
  return (
    <div
      {...handlers}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${PANEL_LABELS.get(panelId)} column`}
      aria-valuenow={width}
      aria-valuemin={BOARD_COLUMN_WIDTH.min}
      aria-valuemax={BOARD_COLUMN_WIDTH.max}
      tabIndex={0}
      onDoubleClick={() => props.onResize(panelId, null)}
      onKeyDown={handleKeyDown}
      className="group absolute inset-y-0 -right-3 z-10 w-3 cursor-col-resize touch-none select-none outline-none"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
      />
    </div>
  );
}

function findDropTarget(
  board: HTMLElement,
  activeId: BoardPanelId,
  point: { x: number; y: number },
): DropTarget | null {
  for (const element of board.querySelectorAll<HTMLElement>("[data-board-panel]")) {
    const rect = element.getBoundingClientRect();
    if (
      point.x < rect.left ||
      point.x > rect.right ||
      point.y < rect.top ||
      point.y > rect.bottom
    ) {
      continue;
    }
    const panelId = element.dataset.boardPanel as BoardPanelId;
    return panelId === activeId ? null : { panelId, edge: resolveBoardDropEdge(rect, point) };
  }
  return null;
}

export function TaskBoardPage() {
  const navigate = useNavigate();
  const threads = useVisibleThreadShells();
  const projects = useProjects();
  const nowMinute = useNowMinute();
  const now = `${nowMinute}:00.000Z`;
  const [shown, setShown] = useState<Record<string, number>>({});
  const [savedLayout, setSavedLayout] = useLocalStorage(
    LAYOUT_STORAGE_KEY,
    null,
    SavedLayoutSchema,
  );
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [activeId, setActiveId] = useState<BoardPanelId | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const groups = groupThreadsByPanel(threads, now);
  const layout = resolveBoardLayout(savedLayout);
  const nowMs = Date.parse(now);

  const updateLayout = (update: (layout: BoardLayout) => BoardLayout) =>
    setSavedLayout((saved) => update(resolveBoardLayout(saved)));
  const openThread = (thread: SidebarThreadSummary) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const showMore = (panelId: BoardPanelId) =>
    setShown((previous) => ({
      ...previous,
      [panelId]: (previous[panelId] ?? PAGE_SIZE) + PAGE_SIZE,
    }));
  const cancelRename = () => setRenamingKey(null);
  const commitRename = (thread: SidebarThreadSummary, title: string) => {
    setRenamingKey(null);
    const trimmed = title.trim();
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (trimmed === thread.title) return;
    void updateThreadMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, title: trimmed },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    });
  };
  const togglePanel = (panelId: BoardPanelId) =>
    updateLayout((current) => toggleBoardPanelCollapsed(current, panelId));
  // Alt+arrows move the panel that holds focus; Shift joins the next column instead.
  const movePanelByKey = (panelId: BoardPanelId, event: ReactKeyboardEvent<HTMLElement>) => {
    const direction = MOVE_KEYS[event.key];
    if (!direction || !event.altKey || event.ctrlKey || event.metaKey) return;
    // Alt+arrows move the caret by word while a card is being renamed.
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    flushSync(() =>
      updateLayout((current) => {
        const target = resolveBoardKeyboardMove(current, panelId, direction, event.shiftKey);
        return target ? moveBoardPanel(current, panelId, target) : current;
      }),
    );
    // The move remounts the panel's column, so focus returns to its header button.
    boardRef.current?.querySelector<HTMLElement>(`[data-board-panel="${panelId}"] button`)?.focus();
  };
  const resizePanels = (weights: PanelWeights) =>
    updateLayout((current) => setBoardPanelWeights(current, weights));
  const resizeColumn = (panelId: BoardPanelId, width: number | null) =>
    updateLayout((current) => setBoardColumnWidth(current, panelId, width));
  const resetColumn = (panelId: BoardPanelId) =>
    updateLayout((current) => resetBoardColumnWeights(current, panelId));
  const endDrag = () => {
    setActiveId(null);
    setDropTarget(null);
    dropTargetRef.current = null;
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const moved = event.active.id as BoardPanelId;
    // The move that activates a drag reaches neither dnd-kit's delta nor the tracker below, so a
    // quick flick is resolved from the last pointer position instead.
    const board = boardRef.current;
    const pointer = pointerRef.current;
    const target =
      dropTargetRef.current ??
      (board !== null && pointer !== null ? findDropTarget(board, moved, pointer) : null);
    if (target !== null) updateLayout((current) => moveBoardPanel(current, moved, target));
    endDrag();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the pointer position for drops that end before a drag-time move
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the pointer against panel rects while a panel drag is active
  useEffect(() => {
    const board = boardRef.current;
    if (activeId === null || board === null) return;
    const onPointerMove = (event: PointerEvent) => {
      const next = findDropTarget(board, activeId, { x: event.clientX, y: event.clientY });
      const current = dropTargetRef.current;
      if (current?.panelId === next?.panelId && current?.edge === next?.edge) return;
      dropTargetRef.current = next;
      setDropTarget(next);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [activeId]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground">Task board</span>
        </WorkspacePageHeader>
        {threads.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>No threads yet</EmptyTitle>
              <EmptyDescription>
                Threads from every project show up here by status.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={(event: DragStartEvent) => setActiveId(event.active.id as BoardPanelId)}
            onDragEnd={handleDragEnd}
            onDragCancel={endDrag}
          >
            {/* Swipes past either edge scroll nothing instead of navigating history. */}
            <div
              ref={boardRef}
              data-history-swipe="off"
              className="flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain p-3"
            >
              {layout.columns.map((column) => {
                const allCollapsed = column.every((id) => layout.collapsed.includes(id));
                return (
                  <div
                    key={column.join(":")}
                    data-board-column
                    className={cn(
                      "relative flex min-h-0 shrink-0 flex-col gap-3",
                      allCollapsed && "w-11",
                    )}
                    style={allCollapsed ? undefined : { width: boardColumnWidth(layout, column) }}
                  >
                    {allCollapsed ? null : (
                      <BoardColumnResizeHandle
                        panelId={column[0]!}
                        width={boardColumnWidth(layout, column)}
                        onResize={resizeColumn}
                      />
                    )}
                    {column.map((panelId, index) => {
                      const expanded = !layout.collapsed.includes(panelId);
                      const mode: PanelMode = expanded
                        ? "expanded"
                        : allCollapsed
                          ? "rail"
                          : "header";
                      const lowerId = expanded
                        ? column.slice(index + 1).find((id) => !layout.collapsed.includes(id))
                        : undefined;
                      return (
                        <div
                          key={panelId}
                          data-board-frame={panelId}
                          className={cn(
                            "relative flex flex-col",
                            mode === "expanded"
                              ? "min-h-28 basis-0"
                              : mode === "rail"
                                ? "min-h-0 flex-1"
                                : "shrink-0",
                          )}
                          style={
                            mode === "expanded"
                              ? { flexGrow: boardPanelWeight(layout, panelId) }
                              : undefined
                          }
                        >
                          <BoardPanel
                            panelId={panelId}
                            label={PANEL_LABELS.get(panelId) ?? panelId}
                            mode={mode}
                            items={groups[panelId]}
                            limit={shown[panelId] ?? PAGE_SIZE}
                            dragging={activeId === panelId}
                            dropEdge={dropTarget?.panelId === panelId ? dropTarget.edge : null}
                            projectTitles={projectTitles}
                            nowMs={nowMs}
                            renamingKey={renamingKey}
                            onOpen={openThread}
                            onStartRename={setRenamingKey}
                            onCommitRename={commitRename}
                            onCancelRename={cancelRename}
                            onShowMore={showMore}
                            onToggle={togglePanel}
                            onMoveKey={movePanelByKey}
                          />
                          {lowerId ? (
                            <BoardPanelResizeHandle
                              upperId={panelId}
                              lowerId={lowerId}
                              upperWeight={boardPanelWeight(layout, panelId)}
                              lowerWeight={boardPanelWeight(layout, lowerId)}
                              onResize={resizePanels}
                              onReset={resetColumn}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeId === null ? null : (
                <div className="w-48 cursor-grabbing rounded-lg border border-border bg-popover px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase shadow-lg">
                  {PANEL_LABELS.get(activeId)} · {groups[activeId].length}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </SidebarInset>
  );
}
