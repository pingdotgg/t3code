import { flushSync } from "react-dom";
import { DndContext, useSensor, useSensors, type CollisionDetection } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";
import type { SortableThreadRowBag } from "../Sidebar";
import {
  collapseDraggedTask,
  createTaskSidebarDragOffset,
  createTaskSidebarCollisionDetection,
  createTaskSidebarSortingStrategy,
} from "../Sidebar.drag";
import { animateSidebarLayoutChanges, type SidebarSection } from "../Sidebar.logic";
import { SidebarDragLifecycle, SidebarPointerSensor } from "../Sidebar.pointer";
import { resolveTaskSidebarDrop, taskSidebarItemId, type TaskSidebarItem } from "../Sidebar.tasks";
import { TaskSidebarRow } from "./TaskSidebarRow";
import type { TaskSidebarModel } from "./useTaskSidebarModel";

const memberClass = "ml-[0.9rem] border-l border-sidebar-border/70 pl-1";

function SortableItem({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (bag: SortableThreadRowBag) => ReactNode;
}) {
  const sortable = useSortable({
    id,
    disabled: { draggable: disabled },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const bag = useMemo(
    () => ({
      listeners: sortable.listeners,
      setNodeRef: sortable.setNodeRef,
      transform: sortable.transform,
      transition: sortable.transition,
      isDragging: sortable.isDragging,
    }),
    [
      sortable.listeners,
      sortable.setNodeRef,
      sortable.transform,
      sortable.transition,
      sortable.isDragging,
    ],
  );
  return children(bag);
}

export function TaskSidebar(props: {
  model: TaskSidebarModel;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  selectedTaskKey: string | null;
  searching: boolean;
  searchIndexByKey: ReadonlyMap<string, number>;
  activeSearchIndex: number;
  snoozedExpanded: boolean;
  settledExpanded: boolean;
  settledVisibleCount: number;
  toggleSnoozed: () => void;
  toggleSettled: () => void;
  showMoreSettled: () => void;
  revealShelf: (shelf: "snoozed" | "settled", visibleCount: number) => void;
  canDrag: (item: TaskSidebarItem) => boolean;
  renderThread: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    sortable: SortableThreadRowBag,
    options: { taskMember: boolean; slim: boolean },
  ) => ReactNode;
  renderDraft: (key: string, taskMember: boolean, bag: SortableThreadRowBag) => ReactNode;
}) {
  const { model } = props;
  const taskNodes = useRef(new Map<string, HTMLLIElement>());
  const setShowAll = useUiStateStore((state) => state.setTaskShowAll);
  const setSettledExpanded = useUiStateStore((state) => state.setTaskSettledExpanded);
  const [dragging, setDragging] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const items = useMemo(
    () => collapseDraggedTask(model.items, activeKey),
    [model.items, activeKey],
  );
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [dragOffset] = useState(createTaskSidebarDragOffset);
  const [placement, setPlacement] = useState<"on" | "before" | "after">("on");
  const placementRef = useRef(placement);
  const sensor = useRef<SidebarPointerSensor | null>(null);
  const attach = useCallback((value: SidebarPointerSensor) => {
    sensor.current = value;
  }, []);
  const finish = useCallback(() => {
    sensor.current = null;
    setDragging(false);
    setActiveKey(null);
    setTargetKey(null);
  }, []);
  const cancel = useCallback(() => {
    sensor.current?.cancel();
  }, []);
  useEffect(() => {
    if (
      activeKey &&
      (props.searching || !model.items.some((item) => taskSidebarItemId(item) === activeKey))
    )
      cancel();
  }, [activeKey, model.items, props.searching, cancel]);
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, { distance: 5, onAttach: attach, onFinish: finish }),
  );
  const detectCollision = useMemo(() => createTaskSidebarCollisionDetection(items), [items]);
  const collision: CollisionDetection = useCallback(
    (args) => {
      const result = detectCollision(args);
      if (result.placement) placementRef.current = result.placement;
      return result.collisions;
    },
    [detectCollision],
  );
  const strategy = useMemo(
    () => createTaskSidebarSortingStrategy({ items, placement, activeOffsetY: dragOffset.read }),
    [items, placement, dragOffset],
  );
  const threadByKey = useMemo(
    () =>
      new Map(
        model.projected.threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]),
      ),
    [model.projected.threads],
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor, dragOffset.capture]}
      onDragStart={(event) => {
        setDragging(true);
        setActiveKey(String(event.active.id));
      }}
      onDragMove={() => {
        if (placement !== placementRef.current) setPlacement(placementRef.current);
      }}
      onDragOver={(event) => {
        if (placement !== placementRef.current) setPlacement(placementRef.current);
        const overKey = event.over ? String(event.over.id) : null;
        const intent = overKey
          ? resolveTaskSidebarDrop(items, String(event.active.id), overKey, placementRef.current)
          : null;
        // Membership drops highlight the owning task even when hovering over its children.
        const owner =
          intent?.kind === "move-to-task"
            ? items.find(
                (item) =>
                  item.kind === "task" &&
                  item.taskRef.taskId === intent.taskRef.taskId &&
                  item.taskRef.environmentId === intent.taskRef.environmentId,
              )
            : undefined;
        setTargetKey(owner ? taskSidebarItemId(owner) : overKey);
      }}
      onDragEnd={(event) => {
        if (!event.over) return;
        const intent = resolveTaskSidebarDrop(
          items,
          String(event.active.id),
          String(event.over.id),
          placementRef.current,
        );
        if (intent) void model.drop(intent);
      }}
    >
      <SidebarDragLifecycle onUnmount={cancel} />
      <SortableContext items={items.map(taskSidebarItemId)} strategy={strategy}>
        <ul
          id={props.searching ? "sidebar-thread-search-results" : undefined}
          role={props.searching ? "listbox" : "list"}
          aria-label={props.searching ? "Task and thread search results" : "Tasks and threads"}
          className="relative flex flex-col gap-px"
        >
          {items.map((item) => (
            <SortableItem
              key={taskSidebarItemId(item)}
              id={taskSidebarItemId(item)}
              disabled={props.searching || model.pending || !props.canDrag(item)}
            >
              {(bag) => {
                const style = {
                  // Match thread rows: divider dimensions must not scale the dragged card.
                  transform: CSS.Translate.toString(bag.transform),
                  transition: bag.transition,
                };
                if (item.kind === "thread") {
                  const thread = threadByKey.get(item.key);
                  return thread
                    ? props.renderThread(thread, item.section, bag, {
                        taskMember: item.taskKey != null,
                        slim: item.slim === true,
                      })
                    : null;
                }
                if (item.kind === "draft")
                  return props.renderDraft(item.key, item.taskKey != null, bag);
                if (item.kind === "task") {
                  const group = model.groupsByTaskKey.get(item.taskKey)!;
                  const project = props.projectByKey.get(
                    `${group.task.environmentId}:${group.task.primaryProjectId}`,
                  );
                  return (
                    <li
                      id={
                        props.searching
                          ? `sidebar-thread-search-result-${props.searchIndexByKey.get(item.key)}`
                          : undefined
                      }
                      role={props.searching ? "option" : undefined}
                      aria-selected={
                        props.searching
                          ? props.searchIndexByKey.get(item.key) === props.activeSearchIndex
                          : undefined
                      }
                      ref={(node) => {
                        bag.setNodeRef(node);
                        if (node) taskNodes.current.set(item.taskKey, node);
                        else taskNodes.current.delete(item.taskKey);
                      }}
                      style={style}
                      {...bag.listeners}
                      className={cn(
                        "list-none",
                        item.section === "active" || item.section === "pinned" ? "py-0.5" : "",
                        bag.isDragging && "relative z-20 bg-sidebar",
                        targetKey === item.key &&
                          activeKey !== item.key &&
                          (placement === "on"
                            ? "rounded-md ring-1 ring-inset ring-primary"
                            : placement === "before"
                              ? "shadow-[0_-2px_0_var(--color-primary)]"
                              : "shadow-[0_2px_0_var(--color-primary)]"),
                        props.searching &&
                          props.searchIndexByKey.get(item.key) === props.activeSearchIndex &&
                          "rounded-md ring-1 ring-inset ring-ring",
                      )}
                    >
                      <TaskSidebarRow
                        task={group.task}
                        project={project}
                        section={item.section}
                        expanded={item.expanded}
                        retainedShelfVisibleCount={item.retainedShelfVisibleCount}
                        revealShelf={props.revealShelf}
                        liveCount={item.counts.live}
                        snoozedCount={item.counts.snoozed}
                        settledCount={item.counts.settled}
                        status={item.status}
                        settleBlocked={item.settleBlocked}
                        timeLabel={item.timeLabel}
                        selected={props.selectedTaskKey === item.taskKey}
                      />
                    </li>
                  );
                }
                if (item.kind === "task-thread-limit")
                  return (
                    <li ref={bag.setNodeRef} style={style} className={cn("list-none", memberClass)}>
                      <button
                        type="button"
                        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs text-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-foreground"
                        aria-expanded={item.showAll}
                        onClick={() => {
                          flushSync(() => setShowAll(item.taskRef, !item.showAll));
                          if (item.showAll)
                            taskNodes.current
                              .get(item.taskKey)
                              ?.scrollIntoView({ block: "nearest", behavior: "instant" });
                        }}
                      >
                        <ChevronDownIcon className={cn("size-3.5", item.showAll && "rotate-180")} />
                        {item.showAll ? "Show less" : `Show all ${item.count} threads`}
                      </button>
                    </li>
                  );
                if (item.kind === "task-settled-header")
                  return (
                    <li ref={bag.setNodeRef} style={style} className={cn("list-none", memberClass)}>
                      <button
                        type="button"
                        aria-expanded={item.expanded}
                        onClick={() => setSettledExpanded(item.taskRef, !item.expanded)}
                        className="flex h-7 w-full cursor-pointer items-center gap-1.5 px-2.5 text-left text-[11px] text-muted-foreground"
                      >
                        <ChevronDownIcon className={cn("size-3", !item.expanded && "-rotate-90")} />
                        Settled · {item.count}
                      </button>
                    </li>
                  );
                const label =
                  item.marker === "pinned-header"
                    ? "Pinned"
                    : item.marker === "pinned-divider" || item.marker === "active-placeholder"
                      ? "Active"
                      : item.marker === "snoozed-header"
                        ? "Snoozed"
                        : "Settled";
                const shelf = item.marker === "snoozed-header" || item.marker === "settled-header";
                const isExpanded =
                  item.marker === "snoozed-header" ? props.snoozedExpanded : props.settledExpanded;
                const count =
                  item.marker === "snoozed-header" ? model.counts.snoozed : model.counts.settled;
                return (
                  <li ref={bag.setNodeRef} style={style} className="list-none">
                    {shelf ? (
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={
                          item.marker === "snoozed-header"
                            ? props.toggleSnoozed
                            : props.toggleSettled
                        }
                        className="flex h-8 w-full cursor-pointer items-center gap-1.5 px-2.5 text-left text-xs text-muted-foreground"
                      >
                        <ChevronDownIcon className={cn("size-3", !isExpanded && "-rotate-90")} />
                        {label}
                        {!isExpanded ? ` (${count})` : ""}
                      </button>
                    ) : (
                      <div
                        className={cn(
                          "px-2.5 text-xs text-muted-foreground",
                          dragging
                            ? "flex h-8 items-center"
                            : item.marker.endsWith("placeholder")
                              ? "h-1"
                              : "h-0 overflow-hidden",
                        )}
                      >
                        {dragging ? label : null}
                      </div>
                    )}
                  </li>
                );
              }}
            </SortableItem>
          ))}
          {props.settledExpanded &&
          model.counts.settled > props.settledVisibleCount &&
          !props.searching ? (
            <li>
              <button
                type="button"
                onClick={props.showMoreSettled}
                className="flex h-9 w-full items-center gap-2 px-2.5 text-xs text-muted-foreground"
              >
                <PlusIcon className="size-3.5" />
                Show more settled
              </button>
            </li>
          ) : null}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
