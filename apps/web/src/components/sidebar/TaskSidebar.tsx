import {
  closestCenter,
  DndContext,
  useSensor,
  useSensors,
  type CollisionDetection,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useUiStateStore } from "../../uiStateStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import type { SortableThreadRowBag } from "../Sidebar";
import { collapseDraggedTask, createTaskSidebarSortingStrategy } from "../Sidebar.drag";
import { animateSidebarLayoutChanges, type SidebarSection } from "../Sidebar.logic";
import { SidebarDragLifecycle, SidebarPointerSensor } from "../Sidebar.pointer";
import { resolveTaskSidebarDrop, taskSidebarItemId, type TaskSidebarItem } from "../Sidebar.tasks";
import { snoozeWakeLabel } from "../Sidebar.snooze";
import { ProjectFavicon } from "../ProjectFavicon";
import { TaskCard } from "./TaskCard";
import { TaskSlimRow } from "./TaskSlimRow";
import type { TaskSidebarModel } from "./useTaskSidebarModel";

const memberClass = "ml-[0.9rem] border-l border-sidebar-border/70 pl-1";

function SortableItem({
  item,
  disabled,
  children,
}: {
  item: TaskSidebarItem;
  disabled: boolean;
  children: (bag: SortableThreadRowBag) => ReactNode;
}) {
  const sortable = useSortable({
    id: taskSidebarItemId(item),
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
  const actions = useTaskActions();
  const setExpanded = useUiStateStore((state) => state.setTaskExpanded);
  const setSettledExpanded = useUiStateStore((state) => state.setTaskSettledExpanded);
  const [dragging, setDragging] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const items = useMemo(
    () => collapseDraggedTask(model.items, activeKey),
    [model.items, activeKey],
  );
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
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
    setOffset(0);
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
  const collision: CollisionDetection = useCallback(
    (args) => {
      const collisions = closestCenter(args);
      const nearest = collisions[0];
      if (!nearest || nearest.id === args.active.id) return collisions;
      const rect = args.droppableRects.get(nearest.id);
      const pointerY = args.pointerCoordinates?.y;
      const next =
        rect && pointerY != null
          ? pointerY < rect.top + Math.min(12, rect.height / 4)
            ? "before"
            : pointerY > rect.bottom - Math.min(12, rect.height / 4)
              ? "after"
              : "on"
          : "on";
      placementRef.current = next;
      const intent = resolveTaskSidebarDrop(
        items,
        String(args.active.id),
        String(nearest.id),
        next,
      );
      return intent ? collisions : collisions.filter((entry) => entry.id === args.active.id);
    },
    [items],
  );
  const strategy = useMemo(
    () => createTaskSidebarSortingStrategy({ items, placement, activeOffsetY: offset }),
    [items, placement, offset],
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
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={(event) => {
        setDragging(true);
        setActiveKey(String(event.active.id));
      }}
      onDragMove={(event) => {
        setOffset(event.delta.y);
        setPlacement(placementRef.current);
      }}
      onDragOver={(event) => {
        setPlacement(placementRef.current);
        setTargetKey(event.over ? String(event.over.id) : null);
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
              item={item}
              disabled={props.searching || model.pending || !props.canDrag(item)}
            >
              {(bag) => {
                const style = {
                  transform: CSS.Transform.toString(bag.transform),
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
                  const rowProps = {
                    task: group.task,
                    expanded: item.expanded,
                    onToggle: () => setExpanded(item.taskRef, !item.expanded),
                    counts: item.counts,
                    status: item.status,
                    primaryProjectName: project?.title ?? "Project",
                    primaryProjectIcon: project ? (
                      <ProjectFavicon project={project} className="size-3.5" />
                    ) : undefined,
                    timeLabel:
                      item.section === "snoozed" && group.task.snoozedUntil
                        ? snoozeWakeLabel(group.task.snoozedUntil, {
                            now: new Date().toISOString(),
                          })
                        : formatRelativeTimeLabel(
                            item.section === "settled"
                              ? (group.task.settledAt ?? group.task.updatedAt)
                              : [...group.live, ...group.snoozed, ...group.settled].reduce(
                                  (latest, member) =>
                                    member.updatedAt > latest ? member.updatedAt : latest,
                                  group.task.updatedAt,
                                ),
                          ),
                    selected: props.selectedTaskKey === item.taskKey,
                  };
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
                      ref={bag.setNodeRef}
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
                      {item.section === "settled" || item.section === "snoozed" ? (
                        <TaskSlimRow {...rowProps} snoozed={item.section === "snoozed"} />
                      ) : (
                        <TaskCard {...rowProps} />
                      )}
                    </li>
                  );
                }
                if (item.kind === "task-new-thread")
                  return (
                    <li ref={bag.setNodeRef} style={style} className={cn("list-none", memberClass)}>
                      <button
                        type="button"
                        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs text-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-foreground"
                        onClick={() => void actions.newThreadInTask(item.taskRef)}
                      >
                        <PlusIcon className="size-3.5" />
                        New thread in task
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
