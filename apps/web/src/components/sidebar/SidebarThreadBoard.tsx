import {
  defaultDropAnimation,
  DndContext,
  DragOverlay,
  type DndContextProps,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarDndLayout } from "../../hooks/useSidebarDndLayout";
import type { SidebarDndBoardEntry } from "../Sidebar.dnd.board";
import {
  sidebarThreadKey,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
  type SidebarThreadDragTransaction,
} from "../Sidebar.dnd.logic";
import {
  SidebarThreadDndBoundary,
  SidebarThreadDndRow,
  SIDEBAR_THREAD_DRAG_PRESENTATION_HEIGHT,
  type SidebarThreadDndRowBag,
  type SidebarThreadDragView,
} from "./SidebarThreadDnd";
import { SidebarThreadDropOutline } from "./SidebarThreadDropOutline";

type SidebarThreadDndContextProps = Pick<
  DndContextProps,
  | "sensors"
  | "collisionDetection"
  | "cancelDrop"
  | "onDragStart"
  | "onDragMove"
  | "onDragOver"
  | "onDragCancel"
  | "onDragEnd"
>;

export interface SidebarThreadRenderState {
  readonly dnd: SidebarThreadDndRowBag | undefined;
  readonly dragView: SidebarThreadDragView | null;
  readonly hidden: boolean;
  readonly inert: boolean;
}

interface SidebarThreadBoardDnd {
  readonly contextProps: SidebarThreadDndContextProps;
  readonly layout: SidebarDndLayout;
  readonly transaction: SidebarThreadDragTransaction | null;
  readonly entries: readonly SidebarDndBoardEntry[];
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly optimisticPinnedOrderActive: boolean;
  readonly dragPreviewVariant: SidebarDndPreviewVariant | null;
  readonly sortingOverIndex: number | null;
  readonly completeDropAnimation: () => void;
  readonly canDragThread: (thread: EnvironmentThreadShell, source: SidebarDndSection) => boolean;
  readonly canDropThreadInSection: (
    thread: EnvironmentThreadShell,
    source: SidebarDndSection,
    destination: SidebarDndSection,
  ) => boolean;
}

function SidebarThreadShelfHeader(props: {
  section: "snoozed" | "settled";
  count: number;
  expanded: boolean;
  dropActive: boolean;
  setDroppableNodeRef: (node: HTMLElement | null) => void;
  onToggle: () => void;
}) {
  const snoozed = props.section === "snoozed";
  const label = snoozed ? "Snoozed" : "Settled";
  const color = snoozed ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50";
  const divider = snoozed ? "bg-blue-500/20 dark:bg-blue-400/15" : "bg-sidebar-border/60";
  const presentationExpanded = props.expanded || props.dropActive;
  return (
    <div data-thread-selection-safe>
      <button
        ref={props.setDroppableNodeRef}
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        data-testid={`sidebar-${props.section}-shelf-toggle`}
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors"
      >
        <span className={cn("text-xs font-medium", color)}>
          {presentationExpanded ? label : `${label} (${props.count})`}
        </span>
        <span className={cn("h-px flex-1", divider)} />
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", presentationExpanded && "rotate-180", color)}
        />
      </button>
    </div>
  );
}

function EmptySectionRail(props: {
  section: SidebarDndSection;
  label: string;
  isOver: boolean;
  setDroppableNodeRef: (node: HTMLElement | null) => void;
}) {
  return (
    <div data-testid={`sidebar-${props.section}-drop-rail`} className="h-12 p-1">
      <div
        ref={props.setDroppableNodeRef}
        className={cn(
          "flex h-10 items-center justify-center rounded-md border border-dashed text-xs font-medium text-muted-foreground/60",
          props.isOver && "border-primary bg-primary/5 text-primary",
        )}
      >
        {props.label}
      </div>
    </div>
  );
}

export function SidebarThreadBoard(props: {
  dnd: SidebarThreadBoardDnd;
  drafts: ReactNode;
  renderThread: (
    thread: EnvironmentThreadShell,
    section: SidebarDndSection,
    state: SidebarThreadRenderState,
  ) => ReactNode;
  snoozedShelf: {
    readonly threadCount: number;
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
  settledShelf: {
    readonly threadCount: number;
    readonly expanded: boolean;
    readonly hiddenCount: number;
    readonly showMoreCount: number;
    readonly onToggle: () => void;
    readonly onShowMore: () => void;
  };
}) {
  const { dnd } = props;
  const emptyRailVisible = (section: SidebarDndSection) =>
    dnd.transaction?.phase === "dragging" &&
    dnd.transaction?.emptySections.has(section) === true &&
    dnd.canDropThreadInSection(
      dnd.transaction.sourceThread,
      dnd.transaction.sourceSection,
      section,
    );
  const pinnedSectionHasThreads = dnd.entries[1]?.kind === "thread";
  const projectedShelfCount = (section: "snoozed" | "settled", canonicalCount: number) => {
    const transaction = dnd.transaction;
    if (transaction === null) return canonicalCount;
    const initialCount = transaction.sectionCounts[section];
    if (transaction.phase === "dragging") return initialCount;
    return Math.max(
      0,
      initialCount -
        (transaction.sourceSection === section ? 1 : 0) +
        (transaction.target.section === section ? 1 : 0),
    );
  };
  const snoozedThreadCount = projectedShelfCount("snoozed", props.snoozedShelf.threadCount);
  const settledThreadCount = projectedShelfCount("settled", props.settledShelf.threadCount);

  const renderBoundary = (entry: Extract<SidebarDndBoardEntry, { readonly kind: "boundary" }>) => (
    <SidebarThreadDndBoundary
      key={entry.id}
      section={entry.section}
      onNodeChange={dnd.layout.handleEntryNodeChange}
    >
      {(bag) => {
        const railVisible = emptyRailVisible(entry.section);
        let content: ReactNode = null;
        switch (entry.section) {
          case "pinned":
            content = railVisible ? (
              <EmptySectionRail
                section="pinned"
                label="Pinned"
                isOver={bag.isOver}
                setDroppableNodeRef={bag.setDroppableNodeRef}
              />
            ) : null;
            break;
          case "regular":
            content = pinnedSectionHasThreads ? (
              <div
                ref={bag.setDroppableNodeRef}
                aria-hidden
                data-testid="sidebar-pinned-divider"
                className="mx-2.5 my-1.5 h-px bg-sidebar-border/60"
              />
            ) : (
              <div
                ref={bag.setDroppableNodeRef}
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
              />
            );
            break;
          case "snoozed":
            content =
              snoozedThreadCount > 0 || railVisible ? (
                <SidebarThreadShelfHeader
                  section="snoozed"
                  count={snoozedThreadCount}
                  expanded={props.snoozedShelf.expanded}
                  dropActive={railVisible || dnd.transaction?.target?.section === "snoozed"}
                  setDroppableNodeRef={bag.setDroppableNodeRef}
                  onToggle={props.snoozedShelf.onToggle}
                />
              ) : null;
            break;
          case "settled":
            content =
              settledThreadCount > 0 ? (
                <SidebarThreadShelfHeader
                  section="settled"
                  count={settledThreadCount}
                  expanded={props.settledShelf.expanded}
                  dropActive={dnd.transaction?.target?.section === "settled"}
                  setDroppableNodeRef={bag.setDroppableNodeRef}
                  onToggle={props.settledShelf.onToggle}
                />
              ) : railVisible ? (
                <EmptySectionRail
                  section="settled"
                  label="Settled"
                  isOver={bag.isOver}
                  setDroppableNodeRef={bag.setDroppableNodeRef}
                />
              ) : null;
            break;
          default: {
            const _exhaustive: never = entry.section;
            return _exhaustive;
          }
        }
        return (
          <li
            ref={bag.setNodeRef}
            aria-hidden={content === null || entry.section === "regular" || undefined}
            data-sidebar-thread-section-boundary={entry.section}
            className={cn("relative list-none", content === null && "h-0")}
            style={{
              transform: CSS.Translate.toString(bag.transform),
              transition: bag.transition,
            }}
          >
            {content}
          </li>
        );
      }}
    </SidebarThreadDndBoundary>
  );

  const renderThread = (
    entry: Extract<SidebarDndBoardEntry, { readonly kind: "thread" }>,
    section: SidebarDndSection,
  ) => {
    const thread = dnd.threadByKey.get(entry.id) ?? entry.thread;
    const threadKey = sidebarThreadKey(thread);
    const sourceTransaction =
      dnd.transaction?.sourceThreadKey === threadKey ? dnd.transaction : null;
    const dragDisabled =
      dnd.optimisticPinnedOrderActive ||
      !dnd.canDragThread(thread, section) ||
      (dnd.transaction !== null && dnd.transaction.phase !== "dragging");
    return (
      <SidebarThreadDndRow
        key={threadKey}
        threadKey={threadKey}
        section={section}
        dragDisabled={dragDisabled}
        disableLayoutAnimation={
          sourceTransaction !== null && section !== sourceTransaction.sourceSection
        }
        onNodeChange={dnd.layout.handleEntryNodeChange}
      >
        {(rowDnd) => {
          const hidden =
            sourceTransaction !== null &&
            (sourceTransaction.phase === "dragging" ||
              sourceTransaction.phase === "awaiting-snooze-choice" ||
              sourceTransaction.phase === "dropping");
          return props.renderThread(thread, section, {
            dnd: rowDnd,
            dragView: null,
            hidden,
            inert: sourceTransaction !== null && sourceTransaction.phase !== "dragging",
          });
        }}
      </SidebarThreadDndRow>
    );
  };

  let section: SidebarDndSection = "pinned";
  const boardEntries = dnd.entries.map((entry) => {
    if (entry.kind === "boundary") {
      section = entry.section;
      return renderBoundary(entry);
    }
    return renderThread(entry, section);
  });
  const dragPresentationHeight =
    dnd.dragPreviewVariant === null
      ? null
      : SIDEBAR_THREAD_DRAG_PRESENTATION_HEIGHT[dnd.dragPreviewVariant];
  const sortingStrategy = useMemo<SortingStrategy>(
    () => (args) => {
      const transform = verticalListSortingStrategy({
        ...args,
        overIndex: dnd.sortingOverIndex ?? args.overIndex,
      });
      if (
        transform === null ||
        args.index === args.activeIndex ||
        dragPresentationHeight === null
      ) {
        return transform;
      }

      const projectedIndex = dnd.sortingOverIndex ?? args.overIndex;
      const activeHeight = args.rects[args.activeIndex]?.height ?? args.activeNodeRect?.height;
      if (activeHeight === undefined) return transform;

      const heightDelta = dragPresentationHeight - activeHeight;
      const shiftsUp =
        projectedIndex > args.activeIndex &&
        args.index > args.activeIndex &&
        args.index <= projectedIndex;
      const shiftsDown =
        projectedIndex < args.activeIndex &&
        args.index < args.activeIndex &&
        args.index >= projectedIndex;
      const extendsPastSource =
        heightDelta > 0 && projectedIndex < args.activeIndex && args.index > args.activeIndex;
      if (!shiftsUp && !shiftsDown && !extendsPastSource) return transform;

      return {
        ...transform,
        y: transform.y + (shiftsUp ? -heightDelta : heightDelta),
      };
    },
    [dnd.sortingOverIndex, dragPresentationHeight],
  );
  const sortableItems = useMemo(() => dnd.entries.map((entry) => entry.id), [dnd.entries]);
  const listRef = useRef<HTMLUListElement>(null);
  const overlayTransaction =
    dnd.transaction?.phase === "dragging" || dnd.transaction?.phase === "awaiting-snooze-choice"
      ? dnd.transaction
      : null;
  const overlayVariant = dnd.dragPreviewVariant;
  const overlayHeight =
    overlayVariant === null ? null : SIDEBAR_THREAD_DRAG_PRESENTATION_HEIGHT[overlayVariant];
  const overlay =
    overlayTransaction === null || overlayVariant === null || overlayHeight === null
      ? null
      : props.renderThread(overlayTransaction.sourceThread, overlayTransaction.sourceSection, {
          dnd: undefined,
          dragView: {
            variant: overlayVariant,
            pointerAnchor: overlayTransaction.pointerAnchor,
          },
          hidden: false,
          inert: true,
        });
  const overlayStyle = {
    margin: 0,
    padding: 0,
    pointerEvents: "none",
    ...(overlayTransaction === null || overlayHeight === null
      ? {}
      : {
          top:
            overlayTransaction.sourceRect.top +
            overlayTransaction.pointerAnchor.y *
              (overlayTransaction.sourceRect.height - overlayHeight),
          left: overlayTransaction.sourceRect.left,
          width: overlayTransaction.sourceRect.width,
          height: overlayHeight,
          transformOrigin: `${overlayTransaction.pointerAnchor.x * 100}% ${overlayTransaction.pointerAnchor.y * 100}%`,
        }),
  } satisfies CSSProperties;
  const dropAnimation = useMemo<DropAnimation>(
    () => ({
      ...defaultDropAnimation,
      duration: 160,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      keyframes: (args) => {
        const keyframes = defaultDropAnimation.keyframes(args);
        const first = keyframes[0];
        const last = keyframes[keyframes.length - 1];
        if (
          first === undefined ||
          last === undefined ||
          JSON.stringify(first) === JSON.stringify(last) ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          queueMicrotask(dnd.completeDropAnimation);
          return last === undefined ? keyframes : [last, last];
        }
        return keyframes;
      },
      sideEffects: (args) => {
        const cleanup = defaultDropAnimation.sideEffects?.(args);
        return () => {
          cleanup?.();
          dnd.completeDropAnimation();
        };
      },
    }),
    [dnd.completeDropAnimation],
  );
  const dragSessionActive =
    dnd.transaction?.phase === "dragging" || dnd.transaction?.phase === "awaiting-snooze-choice";

  return (
    <DndContext
      {...dnd.contextProps}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      autoScroll={{
        enabled: dnd.transaction?.phase === "dragging",
        layoutShiftCompensation: { x: false, y: true },
        canScroll: (element) => element === dnd.layout.viewportRef.current,
      }}
    >
      <ul
        ref={listRef}
        role="list"
        className={cn("relative flex flex-col gap-px", dragSessionActive && "pointer-events-none")}
      >
        {props.drafts}
        <SortableContext items={sortableItems} strategy={sortingStrategy}>
          {boardEntries}
        </SortableContext>
        {dnd.transaction?.phase === "dragging" &&
        dnd.transaction.target !== null &&
        dragPresentationHeight !== null &&
        (dnd.transaction.target.section === "snoozed" ||
          dnd.transaction.target.section === "settled") ? (
          <SidebarThreadDropOutline
            key={dnd.transaction.target.section}
            section={dnd.transaction.target.section}
            sourceSection={dnd.transaction.sourceSection}
            sourceThreadKey={dnd.transaction.sourceThreadKey}
            entries={dnd.transaction.initialEntries}
            target={dnd.transaction.target}
            presentationHeight={dragPresentationHeight}
            listRef={listRef}
            getEntryNode={dnd.layout.getEntryNode}
          />
        ) : null}
        {props.settledShelf.expanded && props.settledShelf.hiddenCount > 0 ? (
          <li className="list-none">
            <button
              type="button"
              onClick={props.settledShelf.onShowMore}
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon aria-hidden className="size-4 shrink-0" />
              Show {props.settledShelf.showMoreCount} more
            </button>
          </li>
        ) : null}
      </ul>
      <DragOverlay
        adjustScale={false}
        dropAnimation={dropAnimation}
        style={overlayStyle}
        wrapperElement="ul"
        zIndex={20}
      >
        {overlay}
      </DragOverlay>
    </DndContext>
  );
}
