import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useClientSettings } from "../../hooks/useSettings";
import { getProjectOrderKey } from "../../logicalProject";
import { useProjectGroupActions } from "../../hooks/useProjectGroupActions";
import { normalizeSearchText } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironmentMachines, useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  filterSidebarV2VisibleThreads,
  orderItemsByPreferredIds,
  sortLogicalProjectsForSidebar,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

interface ProjectActivity {
  readonly threadCount: number;
  readonly lastThreadAt: string | null;
}

/** Every project on every machine, with pin, archive and settings for each. */
export function ProjectsList() {
  const groups = useSettingsProjectGroups();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const actions = useProjectGroupActions();
  const [view, setView] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");

  const scratchRootByEnvironmentId = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          environment.serverConfig?.scratchWorkspaceRoot,
        ]),
      ),
    [environments],
  );
  const projectGroups = useMemo(() => {
    // The home of threads without a project is not a project to manage.
    const managed = groups.filter(
      (group) =>
        !group.memberProjects.every((member) =>
          isScratchProject(member, scratchRootByEnvironmentId.get(member.environmentId)),
        ),
    );
    // Manual order is saved per checkout, as in the sidebar.
    const ordered =
      projectSortOrder === "manual"
        ? orderItemsByPreferredIds({
            items: managed,
            preferredIds: projectOrder,
            getId: (group) => group.projectKey,
            getPreferenceIds: (group) =>
              group.memberProjects.flatMap((member) => [
                getProjectOrderKey(member),
                legacyProjectCwdPreferenceKey(member.workspaceRoot),
              ]),
          })
        : managed;
    return sortLogicalProjectsForSidebar(ordered, threads, projectSortOrder);
  }, [groups, projectOrder, projectSortOrder, scratchRootByEnvironmentId, threads]);

  const activityByKey = useMemo(() => {
    const groupKeyByProjectRef = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (ref) => [`${ref.environmentId}:${ref.projectId}`, group.projectKey] as const,
        ),
      ),
    );
    const activity = new Map<string, { threadCount: number; lastThreadMs: number }>();
    for (const thread of filterSidebarV2VisibleThreads(threads, null)) {
      const key = groupKeyByProjectRef.get(`${thread.environmentId}:${thread.projectId}`);
      if (!key) continue;
      const entry = activity.get(key) ?? { threadCount: 0, lastThreadMs: Number.NEGATIVE_INFINITY };
      entry.threadCount += 1;
      entry.lastThreadMs = Math.max(
        entry.lastThreadMs,
        getThreadSortTimestamp(thread, "updated_at"),
      );
      activity.set(key, entry);
    }
    return new Map(
      [...activity].map(([key, { threadCount, lastThreadMs }]): [string, ProjectActivity] => [
        key,
        {
          threadCount,
          lastThreadAt: Number.isFinite(lastThreadMs) ? new Date(lastThreadMs).toISOString() : null,
        },
      ]),
    );
  }, [projectGroups, threads]);

  const normalizedQuery = normalizeSearchText(query.trim());
  const matches = (group: SidebarProjectSnapshot) =>
    normalizedQuery.length === 0 ||
    [
      group.displayName,
      group.repositoryIdentity?.displayName,
      ...group.memberProjects.map((member) => member.workspaceRoot),
    ].some((value) => value != null && normalizeSearchText(value).includes(normalizedQuery));

  const activeGroups = projectGroups.filter((group) => group.archivedAt == null);
  const archivedGroups = projectGroups
    .filter((group) => group.archivedAt != null)
    .sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
  const pinnedGroups = activeGroups.filter((group) => group.pinnedAt != null);
  const visiblePinned = pinnedGroups.filter(matches);
  const visibleUnpinned = activeGroups.filter((group) => group.pinnedAt == null && matches(group));
  const visibleArchived = archivedGroups.filter(matches);

  const renderRow = (group: SidebarProjectSnapshot, reorderable = false) => (
    <ProjectListRow
      key={group.projectKey}
      group={group}
      activity={activityByKey.get(group.projectKey)}
      environments={environments}
      canOrganize={actions.canOrganize(group)}
      busy={actions.isBusy(group.projectKey)}
      reorderable={reorderable}
      onPin={(pinned) => void actions.setPinned(group, pinned, projectGroups)}
      onArchive={(archived) => void actions.setArchived(group, archived)}
    />
  );

  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4">
        <div className="min-w-48 flex-1">
          <Input
            size="sm"
            type="search"
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ToggleGroup
          aria-label="Project list"
          value={[view]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "active" || value === "archived") setView(value);
          }}
        >
          <Toggle value="active">Active {activeGroups.length}</Toggle>
          <Toggle value="archived">Archived {archivedGroups.length}</Toggle>
        </ToggleGroup>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openCommandPalette({ open: "add-project" })}
        >
          <FolderPlusIcon />
          Add project
        </Button>
      </div>

      {view === "archived" ? (
        <SettingsSection title="Archived">
          {visibleArchived.length > 0 ? (
            visibleArchived.map((group) => renderRow(group))
          ) : (
            <SettingsRow
              title={normalizedQuery ? "No matching projects" : "No archived projects"}
              description={
                normalizedQuery
                  ? "Try a different name or path."
                  : "Archived projects and their threads stay here until you unarchive them."
              }
            />
          )}
        </SettingsSection>
      ) : (
        <>
          {pinnedGroups.length > 0 ? (
            <PinnedProjects
              groups={pinnedGroups}
              isVisible={matches}
              // Dragging a filtered list would skip hidden pins, so search turns
              // it off; so do an older server on any pinned project and a
              // pending write.
              reorderable={
                normalizedQuery.length === 0 &&
                pinnedGroups.every(
                  (group) => actions.canOrganize(group) && !actions.isBusy(group.projectKey),
                )
              }
              onReorder={actions.reorderPinned}
              renderRow={renderRow}
            />
          ) : null}
          <SettingsSection title={visiblePinned.length > 0 ? "Projects" : "All projects"}>
            {visibleUnpinned.length > 0 ? (
              visibleUnpinned.map((group) => renderRow(group))
            ) : (
              <SettingsRow
                title={
                  normalizedQuery
                    ? "No matching projects"
                    : activeGroups.length > 0
                      ? "Every project is pinned"
                      : "No projects yet"
                }
                description={
                  normalizedQuery
                    ? "Try a different name or path."
                    : activeGroups.length > 0
                      ? "Unpin a project to move it here."
                      : "Add a project to start a thread in it."
                }
              />
            )}
          </SettingsSection>
        </>
      )}
    </SettingsPageContainer>
  );
}

/**
 * Pinned projects in their saved order. A drop shows the new order at once
 * and holds it until the server's order changes or the write fails. Another
 * drag waits for that, so each reorder starts from the saved keys.
 */
function PinnedProjects({
  groups,
  isVisible,
  reorderable,
  onReorder,
  renderRow,
}: {
  /** Every pinned project, in saved order; search only hides rows. */
  groups: readonly SidebarProjectSnapshot[];
  isVisible: (group: SidebarProjectSnapshot) => boolean;
  reorderable: boolean;
  onReorder: ReturnType<typeof useProjectGroupActions>["reorderPinned"];
  renderRow: (group: SidebarProjectSnapshot, reorderable?: boolean) => ReactNode;
}) {
  const [held, setHeld] = useState<{
    readonly order: readonly string[];
    readonly serverOrderKey: string;
  } | null>(null);
  const serverOrderKey = groups.map((group) => group.projectKey).join("\n");
  // Once the server's order changes, the write landed (or another edit
  // replaced it), so the held order is done.
  const activeHeld = held !== null && held.serverOrderKey === serverOrderKey ? held : null;
  if (held !== null && activeHeld === null) setHeld(null);
  const groupByKey = new Map(groups.map((group) => [group.projectKey, group]));
  const ordered =
    activeHeld?.order.flatMap((key) => {
      const group = groupByKey.get(key);
      return group ? [group] : [];
    }) ?? groups;
  const visible = ordered.filter(isVisible);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const movedKey = String(event.active.id);
    const overKey = event.over ? String(event.over.id) : null;
    if (overKey === null || overKey === movedKey) return;
    const keys = ordered.map((group) => group.projectKey);
    const nextKeys = arrayMove(keys, keys.indexOf(movedKey), keys.indexOf(overKey));
    const hold = { order: nextKeys, serverOrderKey };
    setHeld(hold);
    void onReorder(
      nextKeys.flatMap((key) => {
        const group = groupByKey.get(key);
        return group ? [group] : [];
      }),
      movedKey,
    ).then((result) => {
      if (result._tag === "Failure") setHeld((current) => (current === hold ? null : current));
    });
  };

  // Stay mounted while a search hides every row, so a held order survives it.
  if (visible.length === 0) return null;
  return (
    <SettingsSection title="Pinned">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visible.map((group) => group.projectKey)}
          strategy={verticalListSortingStrategy}
        >
          {visible.map((group) => (
            <SortablePinnedRow
              key={group.projectKey}
              group={group}
              reorderable={reorderable}
              locked={activeHeld !== null}
              renderRow={renderRow}
            />
          ))}
        </SortableContext>
      </DndContext>
    </SettingsSection>
  );
}

function SortablePinnedRow({
  group,
  reorderable,
  locked,
  renderRow,
}: {
  group: SidebarProjectSnapshot;
  reorderable: boolean;
  /** Dragging waits while an earlier drop is still being saved. */
  locked: boolean;
  renderRow: (group: SidebarProjectSnapshot, reorderable?: boolean) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.projectKey,
    disabled: !reorderable || locked,
  });
  // The whole row drags, like sidebar rows. The 4px activation distance keeps
  // clicks on its link and buttons working.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-10" : undefined}
      {...(reorderable ? { ...attributes, ...listeners } : {})}
    >
      {renderRow(group, reorderable)}
    </div>
  );
}

function ProjectListRow({
  group,
  activity,
  environments,
  canOrganize,
  busy,
  reorderable,
  onPin,
  onArchive,
}: {
  group: SidebarProjectSnapshot;
  activity: ProjectActivity | undefined;
  environments: ReturnType<typeof useEnvironments>["environments"];
  canOrganize: boolean;
  /** A pin or archive write for this project is still running. */
  busy: boolean;
  reorderable: boolean;
  onPin: (pinned: boolean) => void;
  onArchive: (archived: boolean) => void;
}) {
  const machineById = useEnvironmentMachines();
  const pinned = group.pinnedAt != null;
  const archived = group.archivedAt != null;
  const repository = group.repositoryIdentity?.displayName ?? null;
  const memberEnvironmentIds = new Set(group.memberProjects.map((member) => member.environmentId));
  const threadCount = activity?.threadCount ?? 0;
  // The repository when the name does not already say it, else where it lives.
  const details = [
    repository !== null && repository !== group.displayName
      ? repository
      : group.memberProjects.length === 1
        ? group.workspaceRoot
        : `${group.memberProjects.length} checkouts`,
    `${threadCount} ${threadCount === 1 ? "thread" : "threads"}`,
    archived && group.archivedAt
      ? `Archived ${formatRelativeTimeLabel(group.archivedAt)}`
      : activity?.lastThreadAt
        ? `Last thread ${formatRelativeTimeLabel(activity.lastThreadAt)}`
        : null,
  ].filter((value) => value !== null);

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          {reorderable ? (
            <GripVerticalIcon
              aria-hidden
              className="-ml-1 size-3.5 shrink-0 cursor-grab text-muted-foreground/60"
            />
          ) : null}
          <ProjectFavicon project={group} className="size-4 shrink-0" />
          <Link
            to="/projects/$projectKey"
            params={{ projectKey: group.projectKey }}
            className="min-w-0 truncate hover:underline"
          >
            {group.displayName}
          </Link>
        </span>
      }
      description={details.join(" · ")}
      control={
        <div className="flex items-center gap-1">
          {environments.length > 1 ? (
            <span className="mr-2 flex items-center gap-1" aria-label="Machines">
              {environments.map((environment) => {
                const present = memberEnvironmentIds.has(environment.environmentId);
                return (
                  <Tooltip key={environment.environmentId}>
                    <TooltipTrigger
                      render={
                        <span
                          className={
                            present
                              ? "flex size-5 items-center justify-center rounded-sm bg-foreground/[0.07] text-foreground"
                              : "flex size-5 items-center justify-center rounded-sm border border-dashed border-foreground/15 text-muted-foreground/50"
                          }
                        />
                      }
                    >
                      <EnvironmentMachineIcon
                        kind={machineById.get(environment.environmentId) ?? "server"}
                        className="size-3"
                        aria-hidden
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {present ? `On ${environment.label}` : `Not on ${environment.label}`}
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
            </span>
          ) : null}
          {canOrganize && !archived ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              title={pinned ? `Unpin ${group.displayName}` : `Pin ${group.displayName}`}
              aria-label={pinned ? `Unpin ${group.displayName}` : `Pin ${group.displayName}`}
              aria-pressed={pinned}
              disabled={busy}
              onClick={() => onPin(!pinned)}
            >
              {pinned ? <PinOffIcon /> : <PinIcon />}
            </Button>
          ) : null}
          {canOrganize && archived ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onArchive(false)}>
              <ArchiveRestoreIcon />
              Unarchive
            </Button>
          ) : canOrganize ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              title={`Archive ${group.displayName}`}
              aria-label={`Archive ${group.displayName}`}
              disabled={busy}
              onClick={() => onArchive(true)}
            >
              <ArchiveIcon />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            title={`Project settings for ${group.displayName}`}
            aria-label={`Project settings for ${group.displayName}`}
            render={<Link to="/projects/$projectKey" params={{ projectKey: group.projectKey }} />}
          >
            <SettingsIcon />
          </Button>
        </div>
      }
    />
  );
}
