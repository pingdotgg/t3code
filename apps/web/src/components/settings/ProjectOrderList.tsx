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
import { ChevronRightIcon, GripVerticalIcon } from "lucide-react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
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
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const memberKeys = (group: SidebarProjectSnapshot) =>
  group.memberProjects.map((member) => member.physicalProjectKey);

export function ProjectOrderList() {
  const groups = useSidebarProjectGroups();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const { selectScope } = useSettingsScope();
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
    void updateClientSettings({ sidebarProjectSortOrder: "manual" });
  };

  return (
    <SettingsPageContainer>
      <div className="space-y-3">
        <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
          Choose a project to manage its name, icon, checkouts and actions. Drag a project to set
          its place in the sidebar.
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
                  <SortableProjectRow
                    key={group.projectKey}
                    group={group}
                    position={index + 1}
                    onOpen={() =>
                      selectScope({
                        project: getSidebarProjectSettingsKey(group, groupingSettings, projects),
                      })
                    }
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </SettingsGroup>
      </div>
    </SettingsPageContainer>
  );
}

function SortableProjectRow({
  group,
  position,
  onOpen,
}: {
  readonly group: SidebarProjectSnapshot;
  readonly position: number;
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
        "flex items-center gap-2",
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
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}
