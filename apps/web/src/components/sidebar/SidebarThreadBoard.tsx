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
  sidebarThreadKey,
  type SidebarDndPreviewVariant,
  type SidebarDndSection,
  type SidebarThreadDragTransaction,
} from "../Sidebar.dnd.logic";
import {
  SidebarThreadDndRow,
  SidebarThreadDragOverlayContent,
  SidebarThreadSectionDropZone,
  type SidebarThreadDndRowBag,
} from "./SidebarThreadDnd";

type SidebarThreadDndContextProps = Pick<
  DndContextProps,
  "sensors" | "collisionDetection" | "onDragStart" | "onDragMove" | "onDragCancel" | "onDragEnd"
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
  readonly dropIndicator: {
    readonly threadKey: string;
    readonly edge: "before" | "after";
  } | null;
  readonly dragPreviewVariant: SidebarDndPreviewVariant | null;
  readonly canDragThread: (thread: EnvironmentThreadShell, source: SidebarDndSection) => boolean;
  readonly canDropThreadInSection: (
    thread: EnvironmentThreadShell,
    source: SidebarDndSection,
    destination: SidebarDndSection,
  ) => boolean;
  readonly isTemporarySectionRailVisible: (section: SidebarDndSection) => boolean;
}

function SidebarThreadShelfHeader(props: {
  section: "snoozed" | "settled";
  count: number;
  expanded: boolean;
  isDropOver: boolean;
  onToggle: () => void;
}) {
  if (props.count === 0) return null;
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
        className={cn(
          "mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors",
          props.isDropOver &&
            "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-ring/50",
        )}
      >
        <span
          className={cn(
            "text-xs font-medium",
            props.isDropOver ? "text-sidebar-accent-foreground" : color,
          )}
        >
          {props.expanded ? label : `${label} (${props.count})`}
        </span>
        <span className={cn("h-px flex-1", props.isDropOver ? "bg-sidebar-ring/50" : divider)} />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 transition-transform",
            props.expanded && "rotate-180",
            props.isDropOver ? "text-sidebar-accent-foreground" : color,
          )}
        />
      </button>
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
        dimmed: dnd.transaction?.sourceThreadKey === threadKey,
        inert:
          dnd.transaction?.sourceThreadKey === threadKey && dnd.transaction.phase !== "dragging",
        dropIndicator: dnd.dropIndicator?.threadKey === threadKey ? dnd.dropIndicator.edge : null,
      });
    const rowKey = `${threadKey}:${rowVariant}`;
    return (
      <SidebarThreadDndRow
        key={rowKey}
        threadKey={threadKey}
        dragDisabled={dragDisabled}
        dropDisabled={sectionDropDisabled(section)}
        sortable={section === "pinned" && dnd.reorderablePinnedKeys.has(threadKey)}
        onNodeChange={dnd.layout.handleThreadRowNodeChange}
      >
        {renderVisualRow}
      </SidebarThreadDndRow>
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
  const viewportRailTopBySection = dnd.transaction?.viewportRailTopBySection;
  const viewportOverlayHost = dnd.layout.viewportOverlayRef.current;
  const isViewportRail = (section: SidebarDndSection) =>
    viewportOverlayHost !== null &&
    dnd.isTemporarySectionRailVisible(section) &&
    viewportRailTopBySection?.has(section) === true;
  const renderViewportRail = (
    section: SidebarDndSection,
    label: string,
    isOver: boolean,
    setNodeRef: (node: HTMLElement | null) => void,
  ) => {
    const top = viewportRailTopBySection?.get(section);
    if (top === undefined || viewportOverlayHost === null || !isViewportRail(section)) {
      return null;
    }
    return createPortal(
      <div ref={setNodeRef} className="pointer-events-auto absolute inset-x-0 z-30" style={{ top }}>
        {rail(section, label, isOver)}
      </div>,
      viewportOverlayHost,
      `sidebar-${section}-viewport-drop-rail`,
    );
  };
  const renderSection = (
    section: SidebarDndSection,
    label: string,
    content: (isOver: boolean) => ReactNode,
  ) => (
    <SidebarThreadSectionDropZone section={section} disabled={sectionDropDisabled(section)}>
      {({ setNodeRef, isOver }) => {
        const showRail = dnd.isTemporarySectionRailVisible(section);
        const viewportRail = showRail
          ? renderViewportRail(section, label, isOver, setNodeRef)
          : null;
        if (viewportRail !== null) return viewportRail;
        return (
          <li ref={setNodeRef} className="relative list-none">
            {content(isOver)}
            {showRail ? rail(section, label, isOver) : null}
          </li>
        );
      }}
    </SidebarThreadSectionDropZone>
  );

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
        {renderSection("pinned", "Pinned", () => (
          <SortableContext
            items={dnd.sections.pinned
              .map(sidebarThreadKey)
              .filter((threadKey) => dnd.reorderablePinnedKeys.has(threadKey))}
            strategy={dnd.pinnedSortingStrategy}
          >
            <ul role="list" aria-label="Pinned threads" className="flex flex-col gap-px">
              {dnd.sections.pinned.map((thread) => renderThread(thread, "pinned"))}
            </ul>
          </SortableContext>
        ))}
        {(dnd.sections.pinned.length > 0 || dnd.isTemporarySectionRailVisible("pinned")) &&
        !isViewportRail("pinned") ? (
          <li
            aria-hidden
            data-testid="sidebar-pinned-divider"
            className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
          />
        ) : null}
        {renderSection("regular", "Regular", () => (
          <ul role="list" aria-label="Regular threads" className="flex flex-col gap-px">
            {dnd.sections.regular.map((thread) => renderThread(thread, "regular"))}
          </ul>
        ))}
        {renderSection("snoozed", "Snooze", (isOver) => (
          <>
            <SidebarThreadShelfHeader
              section="snoozed"
              count={props.snoozedShelf.threadCount}
              expanded={props.snoozedShelf.expanded}
              isDropOver={isOver && !props.snoozedShelf.expanded}
              onToggle={props.snoozedShelf.onToggle}
            />
            <ul role="list" aria-label="Snoozed threads" className="flex flex-col gap-px">
              {dnd.sections.snoozed.map((thread) => renderThread(thread, "snoozed"))}
            </ul>
          </>
        ))}
        {renderSection("settled", "Settled", (isOver) => (
          <>
            <SidebarThreadShelfHeader
              section="settled"
              count={props.settledShelf.threadCount}
              expanded={props.settledShelf.expanded}
              isDropOver={isOver && !props.settledShelf.expanded}
              onToggle={props.settledShelf.onToggle}
            />
            <ul role="list" aria-label="Settled threads" className="flex flex-col gap-px">
              {dnd.sections.settled.map((thread) => renderThread(thread, "settled"))}
            </ul>
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
          </>
        ))}
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
