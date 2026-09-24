import type { ThreadMoveDestination } from "../threads/threadOrder";
import { computeThreadMoveAvailability } from "../threads/threadOrder";
import { LegendList } from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import { EmptyState } from "../../components/EmptyState";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useThreadSearch } from "../../state/queries";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { usePendingThreadOrder } from "../../state/thread-order";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import {
  buildThreadListV2Items,
  getThreadListV2OrderedSection,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { useMaterialFabScroll } from "./MaterialFabScrollContext";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onAddConnection: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSetThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

// v2 rows are mixed-height: settled slim rows run ~60dp, single-line cards
// measured ~74dp on device (252px on the Pixel 10 Pro screenshot), two-line
// cards ~94dp. The estimate seeds the recycler's initial container count,
// `ceil((scrollLength + 2 * INITIAL_DRAW_DISTANCE) / estimate)` with the
// initial draw distance capped at 50, so an estimate at or below the average
// row height starts the pool at or above the item count for the short lists
// that LegendList otherwise keeps pooling to exactly its item count — that is
// what stopped the dev-mode "no unused container available" warning on the
// seeded short-list device passes. It is a mitigation, not an elimination:
// after first layout the full drawDistance applies, and a sudden expansion
// past the pooled headroom (~25+ items appearing at once) still creates a
// container on demand with the dev-only warning one pass ahead of the
// measured-height pool expansion. The old tallest-card estimate (~92) fired
// that warning on every ordinary shelf expand, so the average wins.
const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 72;
const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const queuedThreadKeys = useQueuedThreadKeys();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const iosBottomToolbarClearance =
    Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED
      ? PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT
      : 0;
  const searchEnvironmentIds = useMemo(
    () =>
      props.selectedEnvironmentId === null
        ? props.environments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : props.environments.some(
              (environment) =>
                environment.environmentId === props.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [props.selectedEnvironmentId]
          : [],
    [props.environments, props.selectedEnvironmentId],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onMaterialFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: props.projects,
        environmentId: props.selectedEnvironmentId,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [props.projectGroupingMode, props.projects, props.selectedEnvironmentId],
  );
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopeProjects = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: projectScopes,
        threads: props.threads,
        pendingTasks: props.pendingTasks,
        projectSortOrder: props.projectSortOrder,
      }),
    [
      props.pendingTasks,
      props.projects,
      props.projectSortOrder,
      props.selectedEnvironmentId,
      props.threads,
      projectScopes,
    ],
  );
  const v2ScopedProjectGroup = useMemo(
    () =>
      v2ProjectScopeKey === null
        ? null
        : (v2ScopeProjects.find(
            (scope) =>
              scope.key === v2ProjectScopeKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  v2ProjectScopeKey,
              ),
          ) ?? null),
    [v2ProjectScopeKey, v2ScopeProjects],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        v2ScopeProjects.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [v2ScopeProjects],
  );
  const v2ScopedProjectKeys = useMemo(
    () =>
      v2ScopedProjectGroup === null
        ? null
        : new Set(
            v2ScopedProjectGroup.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [v2ScopedProjectGroup],
  );
  // Thread List v2 (beta): one flat list in creation order, no grouping.
  // Settled threads collapse into a recency tail below the card block.
  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells — no snapshot merging or
  // optimistic holds.
  const handleSettleThread = props.onSettleThread;
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  const handleMoveThread = useCallback(
    (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
      void props.onMoveThread(thread, direction);
    },
    [props.onMoveThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleSetThreadAutoSettle = useCallback(
    (thread: EnvironmentThreadShell, enabled: boolean) => {
      void props.onSetThreadAutoSettle(thread, enabled);
    },
    [props.onSetThreadAutoSettle],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleRenameThread = useCallback(
    (thread: EnvironmentThreadShell) => props.onRenameThread(thread),
    [props.onRenameThread],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the list stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      // Refresh immediately on enable or focus because the previous value can be hours old.
      setNowMinute(new Date().toISOString().slice(0, 16));
      const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
      return () => clearInterval(id);
    }, []),
  );
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const autoSettleOptOutEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadAutoSettleOptOut === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const activeReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadActiveReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const machineByEnvironmentId = useMemo(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, resolveEnvironmentMachineKind(config)] as const,
        ),
      ),
    [serverConfigs],
  );
  // Reference-stable provider glyphs: a fresh object per render would break
  // the memoized rows' props comparison on every parent render.
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(serverConfigs);
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick);
  // Up/down menu availability for every card, computed once per section per
  // rebuild (see computeThreadMoveAvailability): per-thread planner calls made
  // list construction quadratic, and this list rebuilds on every minute tick.
  const threadMoveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: props.threads,
        section,
        pendingOrder,
        reorderableEnvironmentIds: new Set(
          [...serverConfigs].flatMap(([id, config]) =>
            (section === "pinned"
              ? config.environment.capabilities.threadPinReorder
              : config.environment.capabilities.threadActiveReorder) === true
              ? [id]
              : [],
          ),
        ),
        ordered: getThreadListV2OrderedSection({
          threads: props.threads,
          section,
          pendingOrder,
          now: new Date().toISOString(),
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    return new Map([...sectionAvailability("pinned"), ...sectionAvailability("active")]);
  }, [
    serverConfigs,
    props.threads,
    pendingOrder,
    queuedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    nowMinute,
    snoozeWakeTick,
  ]);
  const threadListV2Layout = useMemo(() => {
    // Settled threads are live shells; archived threads keep their original
    // "hidden from lists" meaning.
    return buildThreadListV2Items({
      pendingOrder,
      threads: props.threads.filter((thread) => thread.archivedAt === null),
      environmentId: props.selectedEnvironmentId,
      projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      settledLimit: settledVisibleCount,
      now: new Date().toISOString(),
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey: null,
    });
  }, [
    pendingOrder,
    queuedThreadKeys,
    nowMinute,
    snoozeWakeTick,
    snoozedShelfExpanded,
    settledShelfExpanded,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    props.searchQuery,
    props.selectedEnvironmentId,
    props.threads,
    matchedThreadKeys,
    v2ScopedProjectGroup,
  ]);
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  // Queued tasks are not thread shells, so the v2 partition never sees them;
  // they are spliced in below the active block and stay visible and deletable
  // while their environment is offline. Same environment scope and search
  // filter as the list itself.
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = useMemo(
    () =>
      props.pendingTasks.filter(
        (pendingTask) =>
          (props.selectedEnvironmentId === null ||
            pendingTask.environmentId === props.selectedEnvironmentId) &&
          (v2ScopedProjectKeys === null ||
            v2ScopedProjectKeys.has(
              scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
            )) &&
          (v2SearchQuery.length === 0 ||
            pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
      ),
    [props.pendingTasks, props.selectedEnvironmentId, v2ScopedProjectKeys, v2SearchQuery],
  );
  const threadListV2Items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: threadListV2Layout.items,
        pendingTasks: v2PendingTasks,
        snoozedCount: threadListV2Layout.snoozedCount,
        snoozedShelfExpanded,
        snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
        settledCount: threadListV2Layout.settledCount,
        settledShelfExpanded,
        settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        moveAvailability: threadMoveAvailability,
        shelfPreferencesLoading: !shelfPreferencesLoaded,
      }),
    [
      nowMinute,
      queuedThreadKeys,
      threadMoveAvailability,
      settledShelfExpanded,
      shelfPreferencesLoaded,
      snoozedShelfExpanded,
      snoozeEnvironmentIds,
      threadListV2Layout,
      v2PendingTasks,
    ],
  );

  useThreadJumpShortcuts(threadListV2Items, props.onSelectThread);

  const renderV2Item = useCallback(
    ({ item }: { readonly item: ThreadListV2ListItem }) => {
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ??
                  null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={item.showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      const thread = item.item.thread;
      return (
        <ThreadListV2Row
          onNewThreadOnBranch={props.onNewThreadOnBranch}
          thread={thread}
          variant={item.item.variant}
          hasQueuedMessages={item.hasQueuedMessages}
          snoozed={item.item.snoozed}
          pinned={item.item.pinned}
          snoozePresetMinute={item.snoozePresetMinute ?? ""}
          snoozeWakeLabelText={item.snoozeWakeLabelText}
          timeLabel={item.timeLabel}
          showTrailingDivider={item.showTrailingDivider}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          projectTitle={v2ProjectTitleByProjectKey.get(
            scopedProjectKey(thread.environmentId, thread.projectId),
          )}
          providerInstance={resolveProviderInstance(thread)}
          environmentLabel={
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          onSelectThread={props.onSelectThread}
          onDeleteThread={handleDeleteThread}
          onArchiveThread={props.onArchiveThread}
          onRenameThread={handleRenameThread}
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={handleSettleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
          reorderSupported={
            item.item.pinned
              ? pinReorderEnvironmentIds.has(thread.environmentId)
              : activeReorderEnvironmentIds.has(thread.environmentId)
          }
          canMoveUp={item.canMoveUp}
          canMoveDown={item.canMoveDown}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onSetThreadAutoSettle={handleSetThreadAutoSettle}
          onMoveThread={handleMoveThread}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
        />
      );
    },
    [
      handleDeleteThread,
      activeReorderEnvironmentIds,
      handleMoveThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleRenameThread,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      handleSetThreadAutoSettle,
      autoSettleOptOutEnvironmentIds,
      pinningEnvironmentIds,
      machineByEnvironmentId,
      pinReorderEnvironmentIds,
      projectByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.onNewThreadOnBranch,
      props.savedConnectionsById,
      resolveProviderInstance,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleSettledShelf,
      toggleSnoozedShelf,
      v2ProjectTitleByProjectKey,
      props.searchQuery,
    ],
  );
  const v2KeyExtractor = useCallback((item: ThreadListV2ListItem) => item.key, []);

  // FlatList/LegendList treat a changed extraData identity as "re-render every
  // visible row", so an inline object literal would invalidate all rows on
  // every HomeScreen render — and the minute clock must stay out of it for
  // the same reason: the clock text is precomputed per item instead.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      serverConfigs,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      threadSearchMatchByKey,
    }),
    [
      projectByKey,
      props.searchQuery,
      props.savedConnectionsById,
      serverConfigs,
      threadSearchMatchByKey,
      v2ProjectTitleByProjectKey,
    ],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so the archived-at check already covers the settled shelf.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    return (
      <View className="flex-1 bg-screen android:bg-header">
        <View
          className={cn(
            "flex-1 items-center justify-center bg-screen px-8",
            Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
          )}
          style={{
            paddingBottom: Math.max(insets.bottom, 24) + iosBottomToolbarClearance,
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
          }}
        >
          <View className="w-full max-w-[430px]">
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
              onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
              action={
                Platform.OS === "android" && !props.catalogState.hasReadyEnvironment ? (
                  <MaterialFloatingActionButton
                    label="Add environment"
                    icon="plus"
                    variant="extended"
                    tone="primary"
                    onPress={props.onAddConnection}
                  />
                ) : undefined
              }
              variant="plain"
            />
            {emptyState.loading ? (
              <View className="mt-4 items-center">
                <ActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  const listHeader = Platform.OS === "ios" ? null : <HomeTopContentSpacer />;

  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface).
  const v2ListHeader = listHeader;

  // Use the v2 project scope for its empty state. Snoozed threads need no
  // special empty state: their shelf header is a list row even while collapsed.
  const v2ListEmpty =
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState
        title="No results"
        detail={`No threads matching "${props.searchQuery}".`}
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or create a new task."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : (
      <EmptyState
        title="No threads yet"
        detail="Create a task to start a new coding session."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    );

  if (Platform.OS === "android" && threadListV2Items.length === 0) {
    return (
      <View className="flex-1 bg-header">
        <View
          className="flex-1 items-center justify-center overflow-hidden rounded-t-[28px] bg-screen px-4"
          style={{ paddingBottom: insets.bottom }}
        >
          {v2ListEmpty}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen android:bg-header">
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
            : "flex-1 bg-screen"
        }
      >
        {/* Shared with the iPad sidebar: cells are reused across data
            rebuilds and `itemsAreEqual` keeps a minute tick (or an unrelated
            shell update) from re-rendering untouched rows. */}
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <LegendList
            data={threadListV2Items}
            renderItem={renderV2Item}
            keyExtractor={v2KeyExtractor}
            getItemType={(item) => item.type}
            itemsAreEqual={threadListV2ListItemsAreEqual}
            estimatedItemSize={ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT}
            drawDistance={500}
            recycleItems
            extraData={v2ExtraData}
            ListHeaderComponent={v2ListHeader}
            ListFooterComponent={
              settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0 ? (
                <ThreadListV2ShowMoreRow
                  hiddenCount={threadListV2Layout.hiddenSettledCount}
                  onPress={showMoreSettled}
                />
              ) : null
            }
            ListEmptyComponent={v2ListEmpty}
            style={{ flex: 1 }}
            automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
            contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            {...scrollGateHandlers}
            scrollEventThrottle={16}
            contentContainerStyle={{
              paddingBottom:
                Platform.OS === "ios"
                  ? Math.max(insets.bottom, 24) + 96 + iosBottomToolbarClearance
                  : Math.max(insets.bottom, 16) + (Platform.OS === "android" ? 148 : 88),
            }}
          />
        </SwipeableScrollGateProvider>
      </View>
    </View>
  );
}
