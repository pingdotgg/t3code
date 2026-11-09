import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { ChevronRightIcon, GripVerticalIcon, PinIcon, PinOffIcon } from "lucide-react";
import { Fragment } from "react";

import { useProjectPin } from "../../hooks/useProjectGroupUpdate";
import { useClientSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { cn } from "../../lib/utils";
import {
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";

const memberKeys = (group: SidebarProjectSnapshot) =>
  group.memberProjects.map((member) => member.physicalProjectKey);

export function ProjectOrderList() {
  const groups = useSidebarProjectGroups();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const { selectScope } = useSettingsScope();
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const shown = pickableProjectGroups(groups);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const dragged = shown.find((group) => group.projectKey === active.id);
    const target = shown.find((group) => group.projectKey === over?.id);
    // Pinned projects always sort first, so a drop across that line could not stick.
    if (!dragged || !target || dragged === target || dragged.pinned !== target.pinned) return;
    reorderProjects(groups.flatMap(memberKeys), memberKeys(dragged), memberKeys(target));
  };

  return (
    <div className="space-y-3">
      <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
        Choose a project to manage its name, icon, checkouts and actions. Drag projects to fix their
        order in the sidebar.
      </p>
      <SettingsGroup>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={shown.map((group) => group.projectKey)}
            strategy={verticalListSortingStrategy}
          >
            <ol aria-label="Projects, in sidebar order">
              {shown.map((group, index) => (
                <Fragment key={group.projectKey}>
                  {shown[index - 1]?.pinned && !group.pinned ? (
                    <li aria-hidden className="mx-3 border-t border-border sm:mx-4" />
                  ) : null}
                  <SortableProjectRow
                    group={group}
                    position={index + 1}
                    canPin={canPinProjectGroup(group)}
                    onTogglePin={() => toggleProjectGroupPin(group)}
                    onOpen={() =>
                      selectScope({
                        project: getSidebarProjectSettingsKey(group, groupingSettings, projects),
                      })
                    }
                  />
                </Fragment>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      </SettingsGroup>
    </div>
  );
}

const PIN_ACTION_CLASSNAME =
  "group/pin flex h-6 w-18 shrink-0 items-center justify-center gap-1 rounded text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function ProjectPinAction({
  name,
  pinned,
  canPin,
  onToggle,
}: {
  readonly name: string;
  readonly pinned: boolean;
  readonly canPin: boolean;
  readonly onToggle: () => void;
}) {
  const pinnedLabel = (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pinned
    </>
  );
  if (!canPin) {
    return pinned ? (
      <span className={cn(PIN_ACTION_CLASSNAME, "text-muted-foreground")}>{pinnedLabel}</span>
    ) : null;
  }
  if (pinned) {
    return (
      <button
        type="button"
        aria-label={`Unpin ${name}`}
        onClick={onToggle}
        className={cn(
          PIN_ACTION_CLASSNAME,
          "cursor-pointer text-muted-foreground group-hover/order:bg-destructive/8 group-hover/order:text-destructive-foreground focus-visible:bg-destructive/8 focus-visible:text-destructive-foreground dark:group-hover/order:bg-destructive/16 dark:focus-visible:bg-destructive/16",
        )}
      >
        <span className="flex items-center gap-1 group-hover/order:hidden group-focus-visible/pin:hidden">
          {pinnedLabel}
        </span>
        <span className="hidden items-center gap-1 group-hover/order:flex group-focus-visible/pin:flex">
          <PinOffIcon aria-hidden className="size-3" />
          Unpin
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Pin ${name}`}
      onClick={onToggle}
      className={cn(
        PIN_ACTION_CLASSNAME,
        "cursor-pointer bg-success/8 text-success-foreground opacity-0 group-hover/order:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 dark:bg-success/16",
      )}
    >
      <PinIcon aria-hidden className="size-3" />
      Pin
    </button>
  );
}

function SortableProjectRow({
  group,
  position,
  canPin,
  onTogglePin,
  onOpen,
}: {
  readonly group: SidebarProjectSnapshot;
  readonly position: number;
  readonly canPin: boolean;
  readonly onTogglePin: () => void;
  readonly onOpen: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.projectKey });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        ITEM_ROW_CLASSNAME,
        "group/order flex items-center gap-2",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${group.displayName}, position ${position}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <span
        aria-hidden
        className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
      >
        {position}
      </span>
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{group.displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {group.workspaceRoot}
          </span>
        </span>
      </button>
      <ProjectPinAction
        name={group.displayName}
        pinned={group.pinned}
        canPin={canPin}
        onToggle={onTogglePin}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="flex shrink-0 cursor-pointer items-center text-muted-foreground"
        onClick={onOpen}
      >
        <ChevronRightIcon className="size-4" />
      </button>
    </li>
  );
}
