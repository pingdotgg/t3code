import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArchiveRestoreIcon,
  CircleAlertIcon,
  EllipsisIcon,
  FolderPlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
import { cn } from "../../lib/utils";
import { useSessionGridFocusStore } from "../../sessionGridFocusStore";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import { orderItemsByPreferredIds } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildSessionGridProjectContextMenuItems,
  buildSessionGridProjectPanelEntries,
  resolveSessionGridChangeRequestState,
  resolveSessionGridLifecycle,
  sessionGridChangeRequestKey,
  type SessionGridProjectContextAction,
  type SessionGridProjectPanelEntry,
} from "./sessionGrid.logic";

interface SortableGridProjectProps {
  readonly entry: SessionGridProjectPanelEntry;
  readonly expanded: boolean;
  readonly restoringThreadKeys: ReadonlySet<string>;
  readonly selected: boolean;
  readonly onOpenActions: (
    entry: SessionGridProjectPanelEntry,
    position: { x: number; y: number },
  ) => void;
  readonly onRestore: (thread: EnvironmentThreadShell, projectKey: string) => void;
  readonly onSelect: (projectKey: string) => void;
  readonly onToggleSettled: (projectKey: string) => void;
}

const SortableGridProject = memo(function SortableGridProject(props: SortableGridProjectProps) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.entry.project.projectKey });
  const project = props.entry.project;
  const openCount = props.entry.openThreads.length;
  const settledCount = props.entry.settledThreads.length;
  const suppressSelectAfterContextMenuRef = useRef(false);
  const openActionsFromButton = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    props.onOpenActions(props.entry, { x: bounds.right, y: bounds.bottom + 2 });
  };

  return (
    <li
      className={cn("relative rounded-md", isDragging && "z-20 opacity-70")}
      data-session-grid-project={project.projectKey}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div
        className={cn(
          "group/project relative flex min-h-13 min-w-0 items-stretch rounded-md border border-transparent",
          "hover:bg-sidebar-row-hover",
          props.selected && "border-sidebar-border/70 bg-sidebar-row-selected",
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          suppressSelectAfterContextMenuRef.current = true;
          window.setTimeout(() => {
            suppressSelectAfterContextMenuRef.current = false;
          }, 0);
          props.onOpenActions(props.entry, { x: event.clientX, y: event.clientY });
        }}
      >
        {props.selected ? (
          <span
            aria-hidden
            className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary/75"
          />
        ) : null}
        <button
          {...attributes}
          {...listeners}
          aria-current={props.selected ? "page" : undefined}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-md py-2 pl-2.5 pr-1 text-left outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring/45"
          onClick={() => {
            if (suppressSelectAfterContextMenuRef.current) {
              suppressSelectAfterContextMenuRef.current = false;
              return;
            }
            props.onSelect(project.projectKey);
          }}
          ref={setActivatorNodeRef}
          type="button"
        >
          <ProjectFavicon
            className="size-4"
            cwd={project.workspaceRoot}
            environmentId={project.environmentId}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-4 text-sidebar-foreground">
              {project.displayName}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-3.5 text-sidebar-muted-foreground">
              <span className="shrink-0 tabular-nums">
                {openCount} open {openCount === 1 ? "session" : "sessions"}
              </span>
              {props.entry.attentionCount > 0 ? (
                <span className="flex min-w-0 items-center gap-1 truncate font-medium text-amber-600 dark:text-amber-300/90">
                  <CircleAlertIcon className="size-3 shrink-0" />
                  <span className="truncate tabular-nums">
                    {props.entry.attentionCount} attention
                  </span>
                </span>
              ) : null}
            </span>
          </span>
        </button>
        {settledCount > 0 ? (
          <button
            aria-expanded={props.expanded}
            aria-label={`${props.expanded ? "Hide" : "Show"} ${settledCount} settled ${settledCount === 1 ? "session" : "sessions"} in ${project.displayName}`}
            className={cn(
              "my-auto mr-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums text-sidebar-muted-foreground outline-none",
              "hover:bg-sidebar-control-surface hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/45",
              props.expanded && "bg-sidebar-control-surface text-sidebar-foreground",
            )}
            onClick={() => props.onToggleSettled(project.projectKey)}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <ArchiveRestoreIcon className="size-3.5" />
            {settledCount}
          </button>
        ) : null}
        <button
          aria-label={`Project actions for ${project.displayName}`}
          className={cn(
            "my-auto mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none",
            "opacity-60 hover:bg-sidebar-control-surface hover:text-sidebar-foreground sm:opacity-0 sm:group-hover/project:opacity-100",
            "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/45",
          )}
          onClick={openActionsFromButton}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      </div>

      {props.expanded && settledCount > 0 ? (
        <div className="mx-1 mt-1 overflow-hidden rounded-md border border-sidebar-border/70 bg-sidebar-control-surface/35">
          <div className="flex h-7 items-center border-sidebar-border/60 border-b px-2 text-[10px] font-medium uppercase tracking-wide text-sidebar-muted-foreground/80">
            Settled sessions
            <span className="ml-auto tabular-nums">{settledCount}</span>
          </div>
          <ul className="max-h-52 overflow-y-auto py-1">
            {props.entry.settledThreads.map((thread) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              const restoring = props.restoringThreadKeys.has(threadKey);
              return (
                <li className="flex min-w-0 items-center gap-1 px-1" key={threadKey}>
                  <span className="min-w-0 flex-1 truncate rounded px-1.5 py-1.5 text-xs text-sidebar-muted-foreground">
                    {thread.title}
                  </span>
                  <Button
                    aria-label={`Restore ${thread.title}`}
                    className="size-6 shrink-0 text-sidebar-muted-foreground hover:text-sidebar-foreground"
                    disabled={restoring}
                    onClick={() => props.onRestore(thread, project.projectKey)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <RotateCcwIcon className={cn("size-3", restoring && "opacity-40")} />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </li>
  );
});

function GridProjectPanelLoading() {
  return (
    <div className="flex flex-col gap-1 px-2 py-2" aria-label="Loading projects">
      {[0, 1, 2].map((index) => (
        <Skeleton className="h-13 rounded-md bg-sidebar-control-surface" key={index} />
      ))}
    </div>
  );
}

// Grid mode uses projects as its navigation level. Thread-level history is
// intentionally tucked behind each project so the primary list stays calm.
export function SessionGridProjectPanel() {
  const navigate = useNavigate();
  const selectedProjectKey =
    useSearch({
      from: "/_chat/grid",
      shouldThrow: false,
      select: (search) => search.project ?? null,
    }) ?? null;
  const { isMobile, setOpenMobile } = useSidebar();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const reorderProjects = useUiStateStore((state) => state.reorderProjects);
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const { unsettleThread } = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const { copyToClipboard: copyProjectPath } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const changeRequestStateByKey = useSessionGridFocusStore(
    (state) => state.changeRequestStateByKey,
  );
  const nowMinute = useNowMinute();
  const [expandedSettledProjectKey, setExpandedSettledProjectKey] = useState<string | null>(null);
  const [restoringThreadKeys, setRestoringThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const environmentConnectionPhaseById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) => [environment.environmentId, environment.connection.phase] as const,
        ),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [environmentLabelById, orderedProjects, primaryEnvironmentId, projectGroupingSettings],
  );
  const lifecycleByThreadKey = useMemo(() => {
    const preciseNow = new Date().toISOString();
    const settledNow = `${nowMinute}:00.000Z`;
    return new Map(
      threads.map((thread) => {
        const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        const changeRequestKey = sessionGridChangeRequestKey({
          threadKey,
          branch: thread.branch,
        });
        const changeRequestState =
          thread.branch === null
            ? null
            : environmentConnectionPhaseById.get(thread.environmentId) !== "connected"
              ? "unknown"
              : resolveSessionGridChangeRequestState(
                  changeRequestStateByKey,
                  changeRequestKey,
                  thread.branch,
                );
        const lifecycle = resolveSessionGridLifecycle(thread, {
          preciseNow,
          settledNow,
          autoSettleAfterDays,
          autoSettleOnMerge,
          supportsSettlement: capabilities?.threadSettlement === true,
          supportsSnooze: capabilities?.threadSnooze === true,
          changeRequestState,
        });
        return [threadKey, lifecycle] as const;
      }),
    );
  }, [
    autoSettleAfterDays,
    autoSettleOnMerge,
    changeRequestStateByKey,
    environmentConnectionPhaseById,
    nowMinute,
    serverConfigs,
    threads,
  ]);
  const entries = useMemo(
    () =>
      buildSessionGridProjectPanelEntries({
        projects: projectGroups,
        threads,
        lifecycleByThreadKey,
        lastVisitedAtByThreadKey,
      }),
    [lastVisitedAtByThreadKey, lifecycleByThreadKey, projectGroups, threads],
  );
  const totals = useMemo(
    () =>
      entries.reduce(
        (result, entry) => ({
          open: result.open + entry.openThreads.length,
          attention: result.attention + entry.attentionCount,
        }),
        { open: 0, attention: 0 },
      ),
    [entries],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const selectProject = useCallback(
    (projectKey: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/grid", search: { project: projectKey } });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const activeProject = projectGroups.find((project) => project.projectKey === event.active.id);
      const overProject = projectGroups.find((project) => project.projectKey === event.over?.id);
      if (!activeProject || !overProject) return;
      reorderProjects(
        orderedProjects.map(getProjectOrderKey),
        activeProject.memberProjects.map((project) => project.physicalProjectKey),
        overProject.memberProjects.map((project) => project.physicalProjectKey),
      );
    },
    [orderedProjects, projectGroups, reorderProjects],
  );
  const toggleSettled = useCallback((projectKey: string) => {
    setExpandedSettledProjectKey((current) => (current === projectKey ? null : projectKey));
  }, []);
  const createSession = useCallback(
    (entry: SessionGridProjectPanelEntry) => {
      selectProject(entry.project.projectKey);
      void handleNewThread(scopeProjectRef(entry.project.environmentId, entry.project.id), {
        navigate: false,
      });
    },
    [handleNewThread, selectProject],
  );
  const removeProjectMembers = useCallback(
    async (entry: SessionGridProjectPanelEntry, members: readonly SidebarProjectGroupMember[]) => {
      const api = readLocalApi();
      if (!api || members.length === 0) return;

      const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? entry.project.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          projectThreads.length > 0
            ? [
                `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                "This permanently clears conversation history for those threads.",
                "Project files on disk are not removed.",
                "This action cannot be undone.",
              ].join("\n")
            : [
                `Remove project "${targetLabel}"?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                "Project files on disk are not removed.",
              ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        const projectDraft = draftStore.getDraftThreadByProjectRef(projectRef);
        const result = await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            ...(memberThreads.length > 0 ? { force: true } : {}),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Failed to remove "${member.title}"`,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }

        if (projectDraft) draftStore.clearDraftThread(projectDraft.draftId);
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (members.length === entry.project.memberProjects.length) {
        setExpandedSettledProjectKey((current) =>
          current === entry.project.projectKey ? null : current,
        );
      }
    },
    [deleteProject, threads],
  );
  const openProjectActions = useCallback(
    (entry: SessionGridProjectPanelEntry, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const action = await api.contextMenu.show<SessionGridProjectContextAction>(
          buildSessionGridProjectContextMenuItems({
            project: entry.project,
            settledCount: entry.settledThreads.length,
            settledExpanded: expandedSettledProjectKey === entry.project.projectKey,
          }),
          position,
        );
        if (!action) return;

        if (action === "open-project") {
          selectProject(entry.project.projectKey);
          return;
        }
        if (action === "new-session") {
          createSession(entry);
          return;
        }
        if (action === "toggle-settled") {
          toggleSettled(entry.project.projectKey);
          return;
        }
        if (action === "remove-all") {
          await removeProjectMembers(entry, entry.project.memberProjects);
          return;
        }
        if (action.startsWith("copy-path:")) {
          const member = entry.project.memberProjects.find(
            (candidate) => candidate.physicalProjectKey === action.slice("copy-path:".length),
          );
          if (member) copyProjectPath(member.workspaceRoot, { path: member.workspaceRoot });
          return;
        }
        if (action.startsWith("remove:")) {
          const member = entry.project.memberProjects.find(
            (candidate) => candidate.physicalProjectKey === action.slice("remove:".length),
          );
          if (member) await removeProjectMembers(entry, [member]);
        }
      })();
    },
    [
      copyProjectPath,
      createSession,
      expandedSettledProjectKey,
      removeProjectMembers,
      selectProject,
      toggleSettled,
    ],
  );
  const restoreThread = useCallback(
    (thread: EnvironmentThreadShell, projectKey: string) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = scopedThreadKey(threadRef);
      setRestoringThreadKeys((current) => new Set(current).add(threadKey));
      void (async () => {
        try {
          const result = await unsettleThread(threadRef);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to restore session",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          selectProject(projectKey);
        } finally {
          setRestoringThreadKeys((current) => {
            const next = new Set(current);
            next.delete(threadKey);
            return next;
          });
        }
      })();
    },
    [selectProject, unsettleThread],
  );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="gap-0"
        fixedHeader={
          <SidebarGroup className="border-sidebar-border/60 border-y px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-sidebar-foreground">Grid projects</div>
                <div className="mt-0.5 truncate text-[11px] text-sidebar-muted-foreground">
                  {totals.open} open
                  {totals.attention > 0 ? ` · ${totals.attention} need attention` : ""}
                </div>
              </div>
              <Button
                aria-label="Add project"
                className="size-7 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                onClick={() => openCommandPalette({ open: "add-project" })}
                size="icon-xs"
                title="Add project"
                variant="ghost"
              >
                <FolderPlusIcon className="size-3.5" />
              </Button>
            </div>
          </SidebarGroup>
        }
      >
        {!bootstrapped ? (
          <GridProjectPanelLoading />
        ) : entries.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs font-medium text-sidebar-foreground">No projects yet</p>
            <p className="mt-1 text-xs leading-5 text-sidebar-muted-foreground">
              Add a project to create its first session grid.
            </p>
            <Button
              className="mt-3"
              onClick={() => openCommandPalette({ open: "add-project" })}
              size="xs"
              variant="outline"
            >
              <FolderPlusIcon />
              Add project
            </Button>
          </div>
        ) : (
          <SidebarGroup className="px-2 py-2">
            <DndContext
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragEnd={handleDragEnd}
              sensors={sensors}
            >
              <SortableContext
                items={entries.map((entry) => entry.project.projectKey)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex min-w-0 flex-col gap-1">
                  {entries.map((entry) => (
                    <SortableGridProject
                      entry={entry}
                      expanded={expandedSettledProjectKey === entry.project.projectKey}
                      key={entry.project.projectKey}
                      onOpenActions={openProjectActions}
                      onRestore={restoreThread}
                      onSelect={selectProject}
                      onToggleSettled={toggleSettled}
                      restoringThreadKeys={restoringThreadKeys}
                      selected={selectedProjectKey === entry.project.projectKey}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
