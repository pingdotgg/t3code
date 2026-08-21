import { DndContext, DragOverlay, MeasuringStrategy, type DndContextProps } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, type SortingStrategy } from "@dnd-kit/sortable";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarDndLayout } from "../../hooks/useSidebarDndLayout";
import type { SidebarThreadBoardSections } from "../Sidebar.dnd.board";
import {
  createSidebarDndDraggableId,
  sidebarThreadKey,
  SIDEBAR_DND_SECTIONS,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
  type SidebarThreadDragTransaction,
} from "../Sidebar.dnd.logic";
import {
  DraggableSidebarThreadRow,
  SidebarThreadDragOverlayContent,
  SidebarThreadSectionDropZone,
  SidebarThreadViewportDropRail,
  SortableSidebarThreadRow,
  type SidebarThreadDndRowBag,
} from "./SidebarThreadDnd";

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
  readonly dimmed: boolean;
  readonly inert: boolean;
  readonly dropIndicator: "before" | "after" | null;
}

export interface SidebarThreadBoardDnd {
  readonly contextProps: SidebarThreadDndContextProps;
  readonly layout: SidebarDndLayout;
  readonly transaction: SidebarThreadDragTransaction | null;
  readonly sections: SidebarThreadBoardSections;
  readonly reorderablePinnedKeys: ReadonlySet<string>;
  readonly pinnedSortingStrategy: SortingStrategy;
  readonly optimisticPinnedOrderActive: boolean;
  readonly dropIndicatorByThreadKey: ReadonlyMap<string, "before" | "after">;
  readonly dragPreviewVariant: SidebarDndPreviewVariant | null;
  readonly canDragThread: (thread: EnvironmentThreadShell, source: SidebarDndSection) => boolean;
  readonly canDropThreadInSection: (
    thread: EnvironmentThreadShell,
    source: SidebarDndSection,
    destination: SidebarDndSection,
  ) => boolean;
  readonly isTemporarySectionRailVisible: (section: SidebarDndSection) => boolean;
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
  dragPreviewProject: {
    readonly title: string | null;
    readonly cwd: string | null;
    readonly faviconPath: string | null;
  } | null;
}) {
  const { dnd } = props;
  const activeDropTransaction = dnd.transaction?.phase === "dragging" ? dnd.transaction : null;
  const sectionDropDisabled = (section: SidebarDndSection) =>
    activeDropTransaction === null ||
    !dnd.canDropThreadInSection(
      activeDropTransaction.sourceThread,
      activeDropTransaction.sourceSection,
      section,
    );
  const renderThread = (thread: EnvironmentThreadShell, section: SidebarDndSection) => {
    const threadKey = sidebarThreadKey(thread);
    const rowVariant = section === "regular" || section === "pinned" ? "card" : "slim";
    const dragDisabled =
      dnd.optimisticPinnedOrderActive ||
      !dnd.canDragThread(thread, section) ||
      (dnd.transaction !== null && dnd.transaction.phase !== "dragging");
    const renderVisualRow = (rowDnd: SidebarThreadDndRowBag) =>
      props.renderThread(thread, section, {
        dnd: rowDnd,
        dimmed:
          dnd.transaction?.sourceThreadKey === threadKey && dnd.transaction.phase !== "reconciling",
        inert:
          dnd.transaction?.sourceThreadKey === threadKey && dnd.transaction.phase !== "dragging",
        dropIndicator: dnd.dropIndicatorByThreadKey.get(threadKey) ?? null,
      });
    const rowKey = `${threadKey}:${rowVariant}`;
    return section === "pinned" && dnd.reorderablePinnedKeys.has(threadKey) ? (
      <SortableSidebarThreadRow
        key={rowKey}
        threadKey={threadKey}
        section={section}
        disabled={dragDisabled}
        onNodeChange={dnd.layout.handleThreadRowNodeChange}
      >
        {renderVisualRow}
      </SortableSidebarThreadRow>
    ) : (
      <DraggableSidebarThreadRow
        key={rowKey}
        threadKey={threadKey}
        section={section}
        dragDisabled={dragDisabled}
        dropDisabled={sectionDropDisabled(section)}
        onNodeChange={dnd.layout.handleThreadRowNodeChange}
      >
        {renderVisualRow}
      </DraggableSidebarThreadRow>
    );
  };
  const rail = (section: SidebarDndSection, label: string, isOver: boolean) => (
    <div data-testid={`sidebar-${section}-drop-rail`} className="h-12 p-1">
      <div
        className={cn(
          "flex h-10 items-center justify-center rounded-md border border-dashed text-xs font-medium text-muted-foreground/60",
          isOver && "border-primary bg-primary/5 text-primary",
        )}
      >
        {label}
      </div>
    </div>
  );
  const visibleRailBySection = new Map<SidebarDndSection, boolean>(
    SIDEBAR_DND_SECTIONS.map((section) => [section, dnd.isTemporarySectionRailVisible(section)]),
  );
  const viewportRailTopBySection = dnd.transaction?.viewportRailTopBySection;
  const viewportOverlayHost = dnd.layout.viewportOverlayRef.current;
  const viewportRailSections = new Set<SidebarDndSection>();
  if (viewportRailTopBySection !== null && viewportRailTopBySection !== undefined) {
    for (const section of viewportRailTopBySection.keys()) {
      if (visibleRailBySection.get(section) === true && viewportOverlayHost !== null) {
        viewportRailSections.add(section);
      }
    }
  }
  const renderViewportRail = (
    section: SidebarDndSection,
    label: string,
    isOver: boolean,
    setNodeRef: (node: HTMLElement | null) => void,
  ) => {
    const top = viewportRailTopBySection?.get(section);
    if (top === undefined || viewportOverlayHost === null || !viewportRailSections.has(section)) {
      return null;
    }
    return createPortal(
      <SidebarThreadViewportDropRail
        section={section}
        top={top}
        setDropNodeRef={setNodeRef}
        onNodeChange={dnd.layout.handleViewportRailNodeChange}
      >
        {rail(section, label, isOver)}
      </SidebarThreadViewportDropRail>,
      viewportOverlayHost,
      `sidebar-${section}-viewport-drop-rail`,
    );
  };

  return (
    <DndContext
      {...dnd.contextProps}
      modifiers={[restrictToVerticalAxis]}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={{
        layoutShiftCompensation: false,
        canScroll: (element) => element === dnd.layout.viewportRef.current,
      }}
    >
      <ul ref={dnd.layout.attachListRef} role="list" className="flex flex-col gap-px">
        {props.drafts}
        <SidebarThreadSectionDropZone section="pinned" disabled={sectionDropDisabled("pinned")}>
          {({ setNodeRef, isOver }) => {
            const showRail = visibleRailBySection.get("pinned") === true;
            const viewportRail = showRail
              ? renderViewportRail("pinned", "Pinned", isOver, setNodeRef)
              : null;
            if (viewportRail !== null) return viewportRail;
            return (
              <li ref={setNodeRef} className="relative list-none">
                <SortableContext
                  items={dnd.sections.pinned
                    .map(sidebarThreadKey)
                    .filter((threadKey) => dnd.reorderablePinnedKeys.has(threadKey))
                    .map((threadKey) =>
                      createSidebarDndDraggableId({ section: "pinned", threadKey }),
                    )}
                  strategy={dnd.pinnedSortingStrategy}
                >
                  <ul role="list" aria-label="Pinned threads" className="flex flex-col gap-px">
                    {dnd.sections.pinned.map((thread) => renderThread(thread, "pinned"))}
                  </ul>
                </SortableContext>
                {showRail ? rail("pinned", "Pinned", isOver) : null}
              </li>
            );
          }}
        </SidebarThreadSectionDropZone>
        {(dnd.sections.pinned.length > 0 || visibleRailBySection.get("pinned") === true) &&
        !viewportRailSections.has("pinned") ? (
          <li
            aria-hidden
            data-testid="sidebar-pinned-divider"
            className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
          />
        ) : null}
        <SidebarThreadSectionDropZone section="regular" disabled={sectionDropDisabled("regular")}>
          {({ setNodeRef, isOver }) => {
            const showRail = visibleRailBySection.get("regular") === true;
            const viewportRail = showRail
              ? renderViewportRail("regular", "Regular", isOver, setNodeRef)
              : null;
            if (viewportRail !== null) return viewportRail;
            return (
              <li ref={setNodeRef} className="relative list-none">
                <ul role="list" aria-label="Regular threads" className="flex flex-col gap-px">
                  {dnd.sections.regular.map((thread) => renderThread(thread, "regular"))}
                </ul>
                {showRail ? rail("regular", "Regular", isOver) : null}
              </li>
            );
          }}
        </SidebarThreadSectionDropZone>
        <SidebarThreadSectionDropZone section="snoozed" disabled={sectionDropDisabled("snoozed")}>
          {({ setNodeRef, isOver }) => {
            const collapsedHeaderDropOver = isOver && !props.snoozedShelf.expanded;
            const showRail = visibleRailBySection.get("snoozed") === true;
            const viewportRail = showRail
              ? renderViewportRail("snoozed", "Snooze", isOver, setNodeRef)
              : null;
            if (viewportRail !== null) return viewportRail;
            return (
              <li ref={setNodeRef} className="relative list-none">
                {props.snoozedShelf.threadCount > 0 ? (
                  <div data-thread-selection-safe>
                    <button
                      type="button"
                      onClick={props.snoozedShelf.onToggle}
                      aria-expanded={props.snoozedShelf.expanded}
                      data-testid="sidebar-snoozed-shelf-toggle"
                      className={cn(
                        "mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors",
                        collapsedHeaderDropOver &&
                          "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring/50",
                      )}
                    >
                      <span
                        className={cn(
                          "text-xs font-medium",
                          collapsedHeaderDropOver
                            ? "text-sidebar-accent-foreground"
                            : "text-blue-600 dark:text-blue-400",
                        )}
                      >
                        {props.snoozedShelf.expanded
                          ? "Snoozed"
                          : `Snoozed (${props.snoozedShelf.threadCount})`}
                      </span>
                      <span
                        className={cn(
                          "h-px flex-1",
                          collapsedHeaderDropOver
                            ? "bg-sidebar-ring/50"
                            : "bg-blue-500/20 dark:bg-blue-400/15",
                        )}
                      />
                      <ChevronDownIcon
                        aria-hidden
                        className={cn(
                          "size-3 transition-transform",
                          props.snoozedShelf.expanded && "rotate-180",
                          collapsedHeaderDropOver
                            ? "text-sidebar-accent-foreground"
                            : "text-blue-600 dark:text-blue-400",
                        )}
                      />
                    </button>
                  </div>
                ) : null}
                <ul role="list" aria-label="Snoozed threads" className="flex flex-col gap-px">
                  {dnd.sections.snoozed.map((thread) => renderThread(thread, "snoozed"))}
                </ul>
                {showRail ? rail("snoozed", "Snooze", isOver) : null}
              </li>
            );
          }}
        </SidebarThreadSectionDropZone>
        <SidebarThreadSectionDropZone section="settled" disabled={sectionDropDisabled("settled")}>
          {({ setNodeRef, isOver }) => {
            const collapsedHeaderDropOver = isOver && !props.settledShelf.expanded;
            const showRail = visibleRailBySection.get("settled") === true;
            const viewportRail = showRail
              ? renderViewportRail("settled", "Settled", isOver, setNodeRef)
              : null;
            if (viewportRail !== null) return viewportRail;
            return (
              <li ref={setNodeRef} className="relative list-none">
                {props.settledShelf.threadCount > 0 ? (
                  <div data-thread-selection-safe>
                    <button
                      type="button"
                      onClick={props.settledShelf.onToggle}
                      aria-expanded={props.settledShelf.expanded}
                      data-testid="sidebar-settled-shelf-toggle"
                      className={cn(
                        "mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors",
                        collapsedHeaderDropOver &&
                          "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring/50",
                      )}
                    >
                      <span
                        className={cn(
                          "text-xs font-medium",
                          collapsedHeaderDropOver
                            ? "text-sidebar-accent-foreground"
                            : "text-muted-foreground/50",
                        )}
                      >
                        {props.settledShelf.expanded
                          ? "Settled"
                          : `Settled (${props.settledShelf.threadCount})`}
                      </span>
                      <span
                        className={cn(
                          "h-px flex-1",
                          collapsedHeaderDropOver ? "bg-sidebar-ring/50" : "bg-sidebar-border/60",
                        )}
                      />
                      <ChevronDownIcon
                        aria-hidden
                        className={cn(
                          "size-3 transition-transform",
                          props.settledShelf.expanded && "rotate-180",
                          collapsedHeaderDropOver
                            ? "text-sidebar-accent-foreground"
                            : "text-muted-foreground/50",
                        )}
                      />
                    </button>
                  </div>
                ) : null}
                <ul role="list" aria-label="Settled threads" className="flex flex-col gap-px">
                  {dnd.sections.settled.map((thread) => renderThread(thread, "settled"))}
                </ul>
                {showRail ? rail("settled", "Settled", isOver) : null}
                {props.settledShelf.expanded && props.settledShelf.hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={props.settledShelf.onShowMore}
                    className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                    Show {props.settledShelf.showMoreCount} more
                  </button>
                ) : null}
              </li>
            );
          }}
        </SidebarThreadSectionDropZone>
      </ul>
      <DragOverlay adjustScale={false} dropAnimation={null}>
        {dnd.transaction?.phase === "dragging" &&
        dnd.dragPreviewVariant !== null &&
        props.dragPreviewProject !== null ? (
          <SidebarThreadDragOverlayContent
            transaction={dnd.transaction}
            variant={dnd.dragPreviewVariant}
            projectTitle={props.dragPreviewProject.title}
            projectCwd={props.dragPreviewProject.cwd}
            projectFaviconPath={props.dragPreviewProject.faviconPath}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
