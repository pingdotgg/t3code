import { ArchiveIcon, BellOffIcon, ChevronDownIcon, ChevronRightIcon, PinIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
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
import { useParams, useRouter } from "@tanstack/react-router";
import {
  QUEUED_TURN_START_GRACE_MS,
  canSettle,
  canSnooze,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import { type OrchestrationThreadActivity } from "@t3tools/contracts";

import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { isElectron } from "../env";
import { shortcutLabelForCommand } from "../keybindings";
import { readLocalApi } from "../localApi";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import {
  buildThreadRouteParams,
  clearAgentRunRouteSearch,
  parseAgentRunRouteSearch,
  resolveThreadRouteRef,
} from "../threadRoutes";
import type { Project, SidebarThreadSummary } from "../types";
import { buildProviderEntriesByEnvironment, scopedProviderInstanceKey } from "../providerInstances";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import {
  agentRunDismissKey,
  deriveSidebarThreadsWithAgentRuns,
  sidebarThreadKey,
} from "../sidebarThreadTree";
import { createThreadExpandedOverridesSelector, useUiStateStore } from "../uiStateStore";
import { usePendingTurnStore } from "../pendingTurnStore";
import {
  classifySidebarV2Shelves,
  resolveThreadLifecycleSupport,
  resolveSidebarV2ThreadRouteTarget,
  selectSnoozeShelfBulkTargets,
  shouldReserveMacSidebarChrome,
  type SidebarV2ThreadGroup,
  type SidebarV2ThreadRow,
} from "./SidebarV2.logic";
import { SidebarV2NestedRow } from "./SidebarV2NestedRow";
import { SidebarV2Row, type SidebarV2RowProps } from "./SidebarV2Row";
import { SidebarHoverThreadPrewarmer } from "./SidebarThreadPrewarmer";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarTrigger,
} from "./ui/sidebar";
import { SidebarTopActions } from "./SidebarTopActions";
import { TITLEBAR_ROW_CLASS, TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS } from "../lib/titlebar";
import { cn } from "../lib/utils";

const SETTLED_PAGE_SIZE = 25;
const EMPTY_THREAD_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];

function SortablePinnedThreadGroup({
  group,
  renderGroup,
}: {
  readonly group: SidebarV2ThreadGroup;
  readonly renderGroup: (
    group: SidebarV2ThreadGroup,
    sortable: NonNullable<SidebarV2RowProps["sortable"]>,
  ) => ReactNode;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: group.rootKey,
  });

  // Transform the whole visible group so expanded descendants ride with the
  // root during drag instead of staying behind and overlapping neighbors.
  return (
    <div
      className={isDragging ? "relative z-20 opacity-80" : undefined}
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {renderGroup(group, {
        attributes,
        isDragging,
        listeners,
        // Node ref + transform live on the group wrapper above.
        setNodeRef: () => {},
      })}
    </div>
  );
}

function PinnedThreadRows({
  projectKey,
  groups,
  renderGroup,
  reorderPinnedThreads,
}: {
  readonly projectKey: string;
  readonly groups: readonly SidebarV2ThreadGroup[];
  readonly renderGroup: (
    group: SidebarV2ThreadGroup,
    sortable: NonNullable<SidebarV2RowProps["sortable"]>,
  ) => ReactNode;
  readonly reorderPinnedThreads: (
    projectKey: string,
    draggedThreadKey: string,
    targetThreadKey: string,
  ) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  // Only roots take part in the drag order: a nested chat rides along with its
  // parent group rather than being reorderable on its own.
  const threadKeys = useMemo(() => groups.map((group) => group.rootKey), [groups]);
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) {
        return;
      }
      reorderPinnedThreads(projectKey, String(active.id), String(over.id));
    },
    [projectKey, reorderPinnedThreads],
  );

  return (
    <DndContext
      collisionDetection={closestCorners}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={handleDragEnd}
      sensors={sensors}
    >
      <SortableContext items={threadKeys} strategy={verticalListSortingStrategy}>
        {groups.map((group) => (
          <SortablePinnedThreadGroup group={group} key={group.rootKey} renderGroup={renderGroup} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function projectByScopedKey(projects: readonly Project[]): Map<string, Project> {
  return new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function startOfTomorrow(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function Shelf({
  title,
  icon,
  count,
  children,
  action,
  defaultOpen = true,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly count: number;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <SidebarGroup className="px-1 py-0">
      {/* The action sits beside the toggle rather than inside it: nesting an
          interactive element in a button is invalid and would swallow clicks. */}
      <div className="group/shelf flex items-center gap-0.5">
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-[length:var(--app-sidebar-meta-font-size)] font-medium text-muted-foreground/80 hover:bg-sidebar-accent hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0" />
          )}
          {icon}
          <span className="truncate">{title}</span>
          <span className="ml-auto tabular-nums text-muted-foreground/60">{count}</span>
        </button>
        {action}
      </div>
      <div id={contentId}>{open ? children : null}</div>
    </SidebarGroup>
  );
}

export default function SidebarV2() {
  const [now, setNow] = useState(nowIso);
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_PAGE_SIZE);
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const { archiveThread, settleThread, snoozeThread, unsettleThread, unsnoozeThread } =
    useThreadActions();
  const router = useRouter();
  const params = useParams({ strict: false });
  const activeThreadRef = resolveThreadRouteRef(params);
  const activeThreadKey = activeThreadRef
    ? `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`
    : null;
  const activeAgentTaskId = parseAgentRunRouteSearch(params).agent ?? null;
  // Classification expands by matching visible row keys. Agent-run routes keep
  // the parent thread id in the path while the selected row uses the synthetic
  // `environment:agent-run:parent:task` key, so pass that key when an agent is
  // selected or a completed run can be collapsed out of view.
  const activeClassificationThreadKey =
    activeThreadRef !== null && activeAgentTaskId !== null
      ? `${activeThreadRef.environmentId}:agent-run:${activeThreadRef.threadId}:${activeAgentTaskId}`
      : activeThreadKey;
  const confirmThreadArchive = useSettings((settings) => settings.confirmThreadArchive);
  const { projects, threads } = useStore(
    useShallow((state) => ({
      projects: selectProjectsAcrossEnvironments(state),
      threads: selectSidebarThreadsAcrossEnvironments(state),
    })),
  );
  const threadActivities = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          threads.map(
            (thread) =>
              selectThreadByRef(state, scopeThreadRef(thread.environmentId, thread.id))
                ?.activities ?? EMPTY_THREAD_ACTIVITIES,
          ),
        [threads],
      ),
    ),
  );
  const dismissedAgentRunKeys = useUiStateStore((state) => state.dismissedAgentRunKeys);
  const pendingThreadKeys = usePendingTurnStore(
    useShallow((state) => Object.keys(state.pendingByThreadKey)),
  );
  const pendingThreadKeySet = useMemo(() => new Set(pendingThreadKeys), [pendingThreadKeys]);
  const setAgentRunDismissed = useUiStateStore((state) => state.setAgentRunDismissed);
  const pinnedThreadKeysByProjectKey = useUiStateStore(
    (state) => state.pinnedThreadKeysByProjectId,
  );
  const setThreadPinned = useUiStateStore((state) => state.setThreadPinned);
  const setThreadExpanded = useUiStateStore((state) => state.setThreadExpanded);
  const reorderPinnedThreads = useUiStateStore((state) => state.reorderPinnedThreads);
  const threadsWithAgentRuns = useMemo(
    () =>
      deriveSidebarThreadsWithAgentRuns({
        threads,
        threadActivities,
        dismissedAgentRunKeys,
      }),
    [dismissedAgentRunKeys, threadActivities, threads],
  );
  // Explicit expand/collapse choices are shared with sidebar v1 and persisted,
  // so a nested chat stays where the user last left it across reloads.
  const expandedOverrideByThreadKey = useUiStateStore(
    useMemo(
      () => createThreadExpandedOverridesSelector(threadsWithAgentRuns.map(sidebarThreadKey)),
      [threadsWithAgentRuns],
    ),
  );
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const keybindings = useServerKeybindings();
  const remoteEnvironmentDescriptors = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    {
      platform: navigator.platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    },
  );
  const hasMacSidebarChrome = shouldReserveMacSidebarChrome({
    isElectron,
    platform: navigator.platform,
  });
  const lifecycleSupport = useMemo(
    () =>
      resolveThreadLifecycleSupport([
        primaryDescriptor,
        ...Object.values(remoteEnvironmentDescriptors).map((saved) => saved.descriptor),
      ]),
    [primaryDescriptor, remoteEnvironmentDescriptors],
  );

  // Classification only changes on its own at two known instants: a snooze
  // elapsing, or a queued turn start ageing out of its grace window. Waking
  // exactly then beats polling every minute and keeps snoozes punctual.
  useEffect(() => {
    const nowMs = Date.parse(now);
    let nextAt = Number.POSITIVE_INFINITY;
    for (const thread of threads) {
      const snoozedUntil = thread.snoozedUntil ?? null;
      const wakeAt = snoozedUntil === null ? Number.NaN : Date.parse(snoozedUntil);
      if (wakeAt > nowMs) {
        nextAt = Math.min(nextAt, wakeAt);
      }
      const messageAt =
        thread.latestUserMessageAt === null ? Number.NaN : Date.parse(thread.latestUserMessageAt);
      const graceEndsAt = messageAt + QUEUED_TURN_START_GRACE_MS;
      if (graceEndsAt > nowMs) {
        nextAt = Math.min(nextAt, graceEndsAt);
      }
    }
    if (!Number.isFinite(nextAt)) {
      return undefined;
    }
    // setTimeout delays are signed 32-bit: anything larger overflows and fires
    // immediately. The padding keeps the wake strictly past the boundary.
    const delayMs = Math.min(Math.max(0, nextAt - Date.now()) + 50, 2_147_483_647);
    const timer = window.setTimeout(() => setNow(nowIso()), delayMs);
    return () => window.clearTimeout(timer);
  }, [now, threads]);

  const projectsByKey = useMemo(() => projectByScopedKey(projects), [projects]);
  // Provider instances are per environment: a saved environment publishes its
  // own catalog, so scoping by instance ID alone would render a remote thread
  // with the primary environment's provider whenever the IDs collide.
  const primaryProviders = useServerProviders();
  const providerEntryByKey = useMemo(
    () =>
      buildProviderEntriesByEnvironment([
        ...(primaryEnvironmentId === null
          ? []
          : [{ environmentId: primaryEnvironmentId, providers: primaryProviders }]),
        ...Object.entries(remoteEnvironmentDescriptors).map(([environmentId, saved]) => ({
          environmentId,
          providers: saved.serverConfig?.providers ?? [],
        })),
      ]),
    [primaryEnvironmentId, primaryProviders, remoteEnvironmentDescriptors],
  );

  // Classifies the store's own thread objects rather than rebuilt copies, so
  // real rows that did not change keep their identity and stay memoized.
  const shelves = useMemo(() => {
    return classifySidebarV2Shelves({
      threads: threadsWithAgentRuns,
      now,
      pinnedThreadKeysByProjectKey,
      expandedOverrideByThreadKey,
      pendingThreadKeys: pendingThreadKeySet,
      ...(activeClassificationThreadKey === null
        ? {}
        : { activeThreadKey: activeClassificationThreadKey }),
    });
  }, [
    activeClassificationThreadKey,
    pendingThreadKeySet,
    expandedOverrideByThreadKey,
    now,
    pinnedThreadKeysByProjectKey,
    threadsWithAgentRuns,
  ]);

  // Snoozed rows the shelf's bulk buttons may actually target.
  const bulkSnoozeTargets = useMemo(
    () =>
      selectSnoozeShelfBulkTargets({
        snoozed: shelves.snoozed.map((group) => group.root),
        lifecycleSupport,
        now,
      }),
    [lifecycleSupport, now, shelves.snoozed],
  );

  const openedSettled = useMemo(() => {
    const included = shelves.settled.slice(0, settledVisibleCount);
    const containsActive = (group: SidebarV2ThreadGroup) =>
      group.rows.some((row) => row.threadKey === activeClassificationThreadKey);
    if (activeClassificationThreadKey !== null && !included.some(containsActive)) {
      const routed = shelves.settled.find(containsActive);
      if (routed) return [...included, routed];
    }
    return included;
  }, [activeClassificationThreadKey, settledVisibleCount, shelves.settled]);

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      const target = resolveSidebarV2ThreadRouteTarget(thread);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, target.threadId)),
        search: target.agentTaskId
          ? (previous) => ({ ...previous, agent: target.agentTaskId ?? undefined })
          : clearAgentRunRouteSearch,
      });
    },
    [router],
  );
  const handleDismissAgentRun = useCallback(
    (thread: SidebarThreadSummary) => {
      const agentRun = thread.virtualAgentRun;
      if (!agentRun || agentRun.status === "running") {
        return;
      }
      setAgentRunDismissed(agentRunDismissKey(agentRun.parentThreadId, agentRun.taskId), true);
    },
    [setAgentRunDismissed],
  );
  const handleSetPinned = useCallback(
    (thread: SidebarThreadSummary, pinned: boolean) => {
      setThreadPinned(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        pinned,
      );
    },
    [setThreadPinned],
  );
  const runAction = useCallback((action: () => Promise<void>, actionLabel: string) => {
    void action().catch((error: unknown) => {
      const description =
        error instanceof Error ? error.message : "An unexpected error prevented this action.";
      console.error("Sidebar inbox lifecycle action failed", error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to ${actionLabel}`,
          description,
        }),
      );
    });
  }, []);
  // Bulk shelf actions fan out to one command per thread — there is no bulk
  // command — so failures are collapsed into a single toast rather than one
  // per thread, which could otherwise bury the screen in duplicates.
  const runBulkAction = useCallback(
    (
      targets: readonly SidebarThreadSummary[],
      action: (thread: SidebarThreadSummary) => Promise<void>,
      actionLabel: string,
    ) => {
      if (targets.length === 0) {
        return;
      }
      void Promise.allSettled(targets.map((thread) => action(thread))).then((results) => {
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length === 0) {
          return;
        }
        console.error("Sidebar inbox bulk lifecycle action failed", failures);
        const firstReason: unknown = failures[0]?.reason;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to ${actionLabel} ${failures.length} of ${targets.length} threads`,
            description:
              firstReason instanceof Error
                ? firstReason.message
                : "An unexpected error prevented this action.",
          }),
        );
      });
    },
    [],
  );
  // Stable per-action handlers: inline arrows would give every row fresh props
  // on each render and defeat ThreadRow's memoization.
  const handleSettle = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => settleThread(scopeThreadRef(thread.environmentId, thread.id)),
        "settle thread",
      );
    },
    [runAction, settleThread],
  );
  const handleUnsettle = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => unsettleThread(scopeThreadRef(thread.environmentId, thread.id)),
        "reopen thread",
      );
    },
    [runAction, unsettleThread],
  );
  const handleSnooze = useCallback(
    (thread: SidebarThreadSummary, until: string) => {
      runAction(
        () => snoozeThread(scopeThreadRef(thread.environmentId, thread.id), until),
        "snooze thread",
      );
    },
    [runAction, snoozeThread],
  );
  const handleUnsnooze = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
        "wake thread",
      );
    },
    [runAction, unsnoozeThread],
  );
  const handleArchive = useCallback(
    (thread: SidebarThreadSummary) => {
      void (async () => {
        if (confirmThreadArchive) {
          const localApi = readLocalApi();
          const confirmed =
            localApi === undefined
              ? window.confirm(`Archive thread "${thread.title}"?`)
              : await localApi.dialogs.confirm(`Archive thread "${thread.title}"?`);
          if (!confirmed) {
            return;
          }
        }
        runAction(
          () => archiveThread(scopeThreadRef(thread.environmentId, thread.id)),
          "archive thread",
        );
      })();
    },
    [archiveThread, confirmThreadArchive, runAction],
  );
  const handleToggleExpanded = useCallback(
    (thread: SidebarThreadSummary, isExpanded: boolean) => {
      setThreadExpanded(sidebarThreadKey(thread), !isExpanded);
    },
    [setThreadExpanded],
  );
  // `now` is deliberately kept OUT of row props: it ticks on every wake timer,
  // and a ticking string would invalidate every memoized row. Time-dependent
  // decisions are collapsed here into booleans that only change when the
  // answer actually changes.
  const renderRow = useCallback(
    (
      row: SidebarV2ThreadRow,
      variant: "card" | "slim",
      sortable?: NonNullable<SidebarV2RowProps["sortable"]>,
    ) => {
      const thread = row.thread;
      const routeTarget = resolveSidebarV2ThreadRouteTarget(thread);
      const isVirtualAgentRun = thread.virtualAgentRun !== undefined;
      const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const project = projectsByKey.get(projectKey);
      const settled = thread.settledOverride === "settled";
      const instanceId = thread.session?.providerInstanceId ?? null;
      const active =
        `${thread.environmentId}:${routeTarget.threadId}` === activeThreadKey &&
        (routeTarget.agentTaskId === null
          ? activeAgentTaskId === null
          : routeTarget.agentTaskId === activeAgentTaskId);
      const providerEntry =
        instanceId === null
          ? null
          : (providerEntryByKey.get(scopedProviderInstanceKey(thread.environmentId, instanceId)) ??
            null);

      // Nested chats share their parent's project, worktree and lifecycle, so
      // their row carries the title alone; everything else would be repetition.
      if (row.depth > 0) {
        return (
          <SidebarV2NestedRow
            active={active}
            archiveBlocked={row.archiveBlocked}
            childCount={row.childCount}
            depth={row.depth}
            hasChildren={row.hasChildren}
            isExpanded={row.isExpanded}
            key={row.threadKey}
            onArchive={handleArchive}
            onDismissAgentRun={handleDismissAgentRun}
            onOpen={openThread}
            onToggleExpanded={handleToggleExpanded}
            projectCwd={project?.cwd ?? null}
            projectName={project?.name ?? "Unknown project"}
            providerEntry={providerEntry}
            thread={thread}
          />
        );
      }

      return (
        <SidebarV2Row
          key={row.threadKey}
          active={active}
          childCount={row.childCount}
          displayStatus={row.displayStatus}
          hasChildren={row.hasChildren}
          isExpanded={row.isExpanded}
          pinned={(pinnedThreadKeysByProjectKey[projectKey] ?? []).includes(row.threadKey)}
          onDismissAgentRun={handleDismissAgentRun}
          onOpen={openThread}
          onSetPinned={handleSetPinned}
          onSettle={handleSettle}
          onSnooze={handleSnooze}
          onToggleExpanded={handleToggleExpanded}
          onUnsettle={handleUnsettle}
          onUnsnooze={handleUnsnooze}
          projectCwd={project?.cwd ?? null}
          projectName={project?.name ?? "Unknown project"}
          providerEntry={providerEntry}
          settled={settled}
          // Reopening is always allowed; only the settle direction has
          // preconditions.
          settleBlocked={!settled && !canSettle(thread, { now })}
          settlementSupported={
            !isVirtualAgentRun && lifecycleSupport.get(thread.environmentId)?.settlement === true
          }
          snoozeBlocked={!canSnooze(thread, { now })}
          snoozeSupported={
            !isVirtualAgentRun && lifecycleSupport.get(thread.environmentId)?.snooze === true
          }
          snoozed={effectiveSnoozed(thread, { now })}
          thread={thread}
          variant={variant}
          {...(sortable ? { sortable } : {})}
        />
      );
    },
    [
      activeThreadKey,
      activeAgentTaskId,
      handleArchive,
      handleDismissAgentRun,
      handleSetPinned,
      handleSettle,
      handleSnooze,
      handleToggleExpanded,
      handleUnsettle,
      handleUnsnooze,
      lifecycleSupport,
      now,
      openThread,
      projectsByKey,
      providerEntryByKey,
      pinnedThreadKeysByProjectKey,
    ],
  );
  const renderGroup = useCallback(
    (
      group: SidebarV2ThreadGroup,
      variant: "card" | "slim",
      sortable?: NonNullable<SidebarV2RowProps["sortable"]>,
    ) =>
      // Only the root accepts drag listeners; the group wrapper owns the
      // transform so nested rows still travel with it.
      group.rows.map((row) => renderRow(row, variant, row.depth === 0 ? sortable : undefined)),
    [renderRow],
  );
  const renderCardGroup = useCallback(
    (group: SidebarV2ThreadGroup) => renderGroup(group, "card"),
    [renderGroup],
  );
  const renderSlimGroup = useCallback(
    (group: SidebarV2ThreadGroup) => renderGroup(group, "slim"),
    [renderGroup],
  );
  const renderPinnedGroup = useCallback(
    (group: SidebarV2ThreadGroup, sortable: NonNullable<SidebarV2RowProps["sortable"]>) =>
      renderGroup(group, "card", sortable),
    [renderGroup],
  );
  const handleNewThreadClick = useCallback(() => {
    if (defaultProjectRef) void handleNewThread(defaultProjectRef);
  }, [defaultProjectRef, handleNewThread]);

  return (
    <>
      {/* The desktop app hides the OS title bar, so this row is the only place
          a collapse control can live beside the window controls. It has to
          exist on every Electron platform, not just the ones that reserve
          space for traffic lights, or collapsing the sidebar becomes
          unreachable once content headers yield the trigger to it. */}
      {isElectron ? (
        <SidebarHeader
          className={cn(
            "drag-region shrink-0 flex-row items-center gap-2 py-0 pr-2",
            hasMacSidebarChrome
              ? TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS
              : "pl-2 wco:pl-[calc(env(titlebar-area-x)+1em)]",
            TITLEBAR_ROW_CLASS,
          )}
        >
          <SidebarTrigger className="no-drag size-6 shrink-0" />
        </SidebarHeader>
      ) : null}
      <SidebarHoverThreadPrewarmer />
      <SidebarContent className="gap-1 pt-1">
        <SidebarTopActions
          commandPaletteShortcutLabel={commandPaletteShortcutLabel}
          newThread={{
            disabled: defaultProjectRef === null,
            onClick: handleNewThreadClick,
          }}
        />
        {shelves.pinned.length > 0 ? (
          <Shelf
            count={shelves.pinned.length}
            icon={<PinIcon className="size-3.5" />}
            title="Pinned"
          >
            <SidebarMenu className="gap-[var(--app-sidebar-row-gap)]">
              {[...shelves.pinnedByProjectKey.entries()].map(([projectKey, pinnedGroups]) => (
                <PinnedThreadRows
                  groups={pinnedGroups}
                  key={projectKey}
                  projectKey={projectKey}
                  renderGroup={renderPinnedGroup}
                  reorderPinnedThreads={reorderPinnedThreads}
                />
              ))}
            </SidebarMenu>
          </Shelf>
        ) : null}
        <SidebarGroup className="px-1 py-0">
          <SidebarMenu className="gap-[var(--app-sidebar-row-gap)]">
            {shelves.active.map(renderCardGroup)}
          </SidebarMenu>
        </SidebarGroup>
        <Shelf
          count={shelves.snoozed.length}
          defaultOpen={false}
          icon={<BellOffIcon className="size-3.5" />}
          title="Snoozed"
        >
          <SidebarMenu className="gap-[var(--app-sidebar-row-gap)]">
            {shelves.snoozed.map(renderSlimGroup)}
          </SidebarMenu>
          {bulkSnoozeTargets.wakeable.length > 0 ? (
            <div className="flex gap-1 px-2 py-1">
              <Button
                onClick={() =>
                  runBulkAction(
                    bulkSnoozeTargets.wakeable,
                    (thread) => unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
                    "wake",
                  )
                }
                size="xs"
                variant="ghost"
              >
                Wake all
              </Button>
              {bulkSnoozeTargets.reschedulable.length > 0 ? (
                <Button
                  onClick={() =>
                    runBulkAction(
                      bulkSnoozeTargets.reschedulable,
                      (thread) =>
                        snoozeThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                          startOfTomorrow(),
                        ),
                      "snooze",
                    )
                  }
                  size="xs"
                  variant="ghost"
                >
                  Until tomorrow
                </Button>
              ) : null}
            </div>
          ) : null}
        </Shelf>
        <Shelf
          count={shelves.settled.length}
          defaultOpen={false}
          icon={<ArchiveIcon className="size-3.5" />}
          title="Settled"
        >
          <SidebarMenu className="gap-[var(--app-sidebar-row-gap)]">
            {openedSettled.map(renderSlimGroup)}
          </SidebarMenu>
          {shelves.settled.length > openedSettled.length ? (
            <Button
              className="mx-2 mt-1"
              onClick={() => setSettledVisibleCount((count) => count + SETTLED_PAGE_SIZE)}
              size="sm"
              variant="ghost"
            >
              Show more
            </Button>
          ) : null}
        </Shelf>
      </SidebarContent>
    </>
  );
}
