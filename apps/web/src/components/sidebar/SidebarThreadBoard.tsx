import { DndContext, type DndContextProps } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
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
  type SidebarThreadDndBoundaryBag,
  type SidebarThreadDndRowBag,
  type SidebarThreadDragView,
} from "./SidebarThreadDnd";
import { SidebarThreadDropOutline } from "./SidebarThreadDropOutline";

type SidebarThreadDndContextProps = Pick<
  DndContextProps,
  | "sensors"
  | "collisionDetection"
  | "onDragStart"
  | "onDragMove"
  | "onDragOver"
  | "onDragCancel"
  | "onDragEnd"
>;

export interface SidebarThreadRenderState {
  readonly dnd: SidebarThreadDndRowBag;
  readonly dragView: SidebarThreadDragView | null;
  readonly inert: boolean;
}

export interface SidebarThreadBoardDnd {
  readonly contextProps: SidebarThreadDndContextProps;
  readonly layout: SidebarDndLayout;
  readonly transaction: SidebarThreadDragTransaction | null;
  readonly entries: readonly SidebarDndBoardEntry[];
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly optimisticPinnedOrderActive: boolean;
  readonly dragPreviewVariant: SidebarDndPreviewVariant | null;
  readonly sortingOverIndex: number | null;
  readonly canDragThread: (thread: EnvironmentThreadShell, source: SidebarDndSection) => boolean;
  readonly canDropThreadInSection: (
    thread: EnvironmentThreadShell,
    source: SidebarDndSection,
    destination: SidebarDndSection,
  ) => boolean;
}

function sortableStyle(bag: {
  readonly transform: SidebarThreadDndBoundaryBag["transform"];
  readonly transition: string | undefined;
}): CSSProperties {
  return {
    transform: CSS.Translate.toString(bag.transform),
    transition: bag.transition,
  };
}

function SidebarThreadShelfHeader(props: {
  section: "snoozed" | "settled";
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const snoozed = props.section === "snoozed";
  const label = snoozed ? "Snoozed" : "Settled";
  const color = snoozed ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50";
  const divider = snoozed ? "bg-blue-500/20 dark:bg-blue-400/15" : "bg-sidebar-border/60";
  return (
    <div data-thread-selection-safe>
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        data-testid={`sidebar-${props.section}-shelf-toggle`}
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors"
      >
        <span className={cn("text-xs font-medium", color)}>
          {props.expanded ? label : `${label} (${props.count})`}
        </span>
        <span className={cn("h-px flex-1", divider)} />
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", props.expanded && "rotate-180", color)}
        />
      </button>
    </div>
  );
}

function EmptySectionRail(props: { section: SidebarDndSection; label: string; isOver: boolean }) {
  return (
    <div data-testid={`sidebar-${props.section}-drop-rail`} className="h-12 p-1">
      <div
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
    dnd.transaction?.emptySections.has(section) === true &&
    dnd.canDropThreadInSection(
      dnd.transaction.sourceThread,
      dnd.transaction.sourceSection,
      section,
    );
  const pinnedSectionHasThreads =
    dnd.transaction === null
      ? dnd.entries[1]?.kind === "thread"
      : !dnd.transaction.emptySections.has("pinned");

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
              <EmptySectionRail section="pinned" label="Pinned" isOver={bag.isOver} />
            ) : null;
            break;
          case "regular":
            content = railVisible ? (
              <EmptySectionRail section="regular" label="Regular" isOver={bag.isOver} />
            ) : pinnedSectionHasThreads ? (
              <div
                aria-hidden
                data-testid="sidebar-pinned-divider"
                className="mx-2.5 my-1.5 h-px bg-sidebar-border/60"
              />
            ) : null;
            break;
          case "snoozed":
            content =
              props.snoozedShelf.threadCount > 0 || railVisible ? (
                <SidebarThreadShelfHeader
                  section="snoozed"
                  count={props.snoozedShelf.threadCount}
                  expanded={railVisible || props.snoozedShelf.expanded}
                  onToggle={props.snoozedShelf.onToggle}
                />
              ) : null;
            break;
          case "settled":
            content =
              props.settledShelf.threadCount > 0 ? (
                <SidebarThreadShelfHeader
                  section="settled"
                  count={props.settledShelf.threadCount}
                  expanded={props.settledShelf.expanded}
                  onToggle={props.settledShelf.onToggle}
                />
              ) : railVisible ? (
                <EmptySectionRail section="settled" label="Settled" isOver={bag.isOver} />
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
            data-sidebar-thread-section-boundary={entry.section}
            className={cn("relative list-none", content === null && "h-0")}
            style={sortableStyle(bag)}
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
          dnd.transaction?.sourceThreadKey === threadKey &&
          section !== dnd.transaction.sourceSection
        }
        onNodeChange={dnd.layout.handleEntryNodeChange}
      >
        {(rowDnd) =>
          props.renderThread(thread, section, {
            dnd: rowDnd,
            dragView:
              rowDnd.isDragging &&
              dnd.transaction?.phase === "dragging" &&
              dnd.dragPreviewVariant !== null
                ? {
                    variant: dnd.dragPreviewVariant,
                    sourceRect: dnd.transaction.sourceRect,
                    translation: {
                      x: rowDnd.transform?.x ?? 0,
                      y: rowDnd.transform?.y ?? 0,
                    },
                    scrollDeltaY:
                      (dnd.layout.viewportRef.current?.scrollTop ??
                        dnd.transaction.sourceScrollTop) - dnd.transaction.sourceScrollTop,
                    pointerAnchor: dnd.transaction.pointerAnchor,
                  }
                : null,
            inert:
              dnd.transaction?.sourceThreadKey === threadKey &&
              dnd.transaction.phase !== "dragging",
          })
        }
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
  const dragSourceHeight =
    dnd.transaction?.phase === "dragging" ? dnd.transaction.sourceRect.height : null;
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
        dragSourceHeight === null ||
        dragPresentationHeight === null
      ) {
        return transform;
      }

      const projectedIndex = dnd.sortingOverIndex ?? args.overIndex;
      const followsProjectedActive =
        projectedIndex < args.activeIndex
          ? args.index >= projectedIndex
          : args.index > projectedIndex;
      if (!followsProjectedActive) return transform;

      const heightDelta = dragPresentationHeight - dragSourceHeight;
      return {
        ...transform,
        y: transform.y + heightDelta,
      };
    },
    [dnd.sortingOverIndex, dragPresentationHeight, dragSourceHeight],
  );
  const listRef = useRef<HTMLUListElement>(null);

  return (
    <DndContext
      {...dnd.contextProps}
      modifiers={[restrictToVerticalAxis]}
      autoScroll={{
        layoutShiftCompensation: false,
        canScroll: (element) => element === dnd.layout.viewportRef.current,
      }}
    >
      <ul
        ref={listRef}
        role="list"
        className={cn(
          "relative flex flex-col gap-px",
          dnd.transaction?.phase === "dragging" && "pointer-events-none",
        )}
      >
        {props.drafts}
        <SortableContext items={dnd.entries.map((entry) => entry.id)} strategy={sortingStrategy}>
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
    </DndContext>
  );
}
