import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "../threads/thread-list-items";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "./homeListItems";
import {
  buildHomeProjectScopes,
  buildHomeThreadGroups,
  sortHomeProjectScopes,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";

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
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
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
  readonly onMovePinnedThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

const ESTIMATED_THREAD_ROW_HEIGHT = 72;
const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header (AndroidHomeHeader) is rendered in-flow above this screen and
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
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
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
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
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
  const effectiveGroupDisplayStates = useMemo(() => {
    const next = new Map(groupDisplayStates);
    if (!AsyncResult.isSuccess(preferencesResult)) {
      return next;
    }
    for (const key of preferencesResult.value.collapsedProjectGroups ?? []) {
      const existing = next.get(key);
      next.set(key, {
        ...(existing ?? DEFAULT_GROUP_DISPLAY_STATE),
        collapsed: true,
      });
    }
    return next;
  }, [groupDisplayStates, preferencesResult]);
  const effectiveGroupDisplayStatesRef = useRef(effectiveGroupDisplayStates);
  effectiveGroupDisplayStatesRef.current = effectiveGroupDisplayStates;

  const updateGroupDisplay = useCallback(
    (key: string, action: HomeGroupDisplayAction) => {
      const next = new Map(effectiveGroupDisplayStatesRef.current);
      next.set(key, nextGroupDisplayState(next.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action));
      effectiveGroupDisplayStatesRef.current = next;
      setGroupDisplayStates(next);
      if (action === "toggle-collapsed") {
        const collapsedProjectGroups: string[] = [];
        for (const [groupKey, state] of next) {
          if (state.collapsed) {
            collapsedProjectGroups.push(groupKey);
          }
        }
        savePreferences({ collapsedProjectGroups });
      }
    },
    [savePreferences],
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
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
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
  const selectedProjectScope = useMemo(
    () =>
      props.selectedProjectKey === null
        ? null
        : (projectScopes.find(
            (scope) =>
              scope.key === props.selectedProjectKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  props.selectedProjectKey,
              ),
          ) ?? null),
    [projectScopes, props.selectedProjectKey],
  );
  const selectedProjectRefKeys = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );
  const scopedProjects = useMemo(
    () =>
      selectedProjectRefKeys === null
        ? props.projects
        : props.projects.filter((project) =>
            selectedProjectRefKeys.has(scopedProjectKey(project.environmentId, project.id)),
          ),
    [props.projects, selectedProjectRefKeys],
  );
  const scopedThreads = useMemo(
    () =>
      selectedProjectRefKeys === null
        ? props.threads
        : props.threads.filter((thread) =>
            selectedProjectRefKeys.has(scopedProjectKey(thread.environmentId, thread.projectId)),
          ),
    [props.threads, selectedProjectRefKeys],
  );
  const scopedPendingTasks = useMemo(
    () =>
      selectedProjectRefKeys === null
        ? props.pendingTasks
        : props.pendingTasks.filter((pendingTask) =>
            selectedProjectRefKeys.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            ),
          ),
    [props.pendingTasks, selectedProjectRefKeys],
  );

  const projectGroups = useMemo(
    () =>
      buildHomeThreadGroups({
        projects: scopedProjects,
        threads: scopedThreads,
        pendingTasks: scopedPendingTasks,
        environmentId: props.selectedEnvironmentId,
        searchQuery: props.searchQuery,
        matchedThreadKeys,
        projectSortOrder: props.projectSortOrder,
        threadSortOrder: props.threadSortOrder,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [
      props.projectGroupingMode,
      props.projectSortOrder,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threadSortOrder,
      matchedThreadKeys,
      scopedPendingTasks,
      scopedProjects,
      scopedThreads,
    ],
  );

  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const listLayout = useMemo(
    () =>
      buildHomeListLayout({
        groups: projectGroups,
        displayStates: effectiveGroupDisplayStates,
        showAllThreads: hasSearchQuery,
      }),
    [projectGroups, effectiveGroupDisplayStates, hasSearchQuery],
  );

  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [props.projects]);

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
  const handleSettleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onSettleThread(thread);
    },
    [props.onSettleThread],
  );
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
  const handleMovePinnedThread = useCallback(
    (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      void props.onMovePinnedThread(thread, direction);
    },
    [props.onMovePinnedThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
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
      if (!threadListV2Enabled) return;
      // Refresh immediately on enable or focus because the previous value can be hours old.
      setNowMinute(new Date().toISOString().slice(0, 16));
      const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
      return () => clearInterval(id);
    }, [threadListV2Enabled]),
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
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
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
  // Canonical arranged pinned order (reorder-capable threads only) for the
  // Move up/down position flags. Computed from all shells, not the rendered
  // list, so search/scope filtering never disables or misdirects a move.
  const arrangedPinnedKeys = useMemo(() => {
    const pinned = sortPinnedThreadsByOrderKey(
      props.threads.filter(
        (thread) =>
          thread.pinnedAt != null &&
          thread.archivedAt === null &&
          pinReorderEnvironmentIds.has(thread.environmentId),
      ),
    );
    return pinned.map((thread) => `${thread.environmentId}:${thread.id}`);
  }, [pinReorderEnvironmentIds, props.threads]);
  const threadListV2Layout = useMemo(() => {
    if (!threadListV2Enabled)
      return {
        items: [],
        hiddenSettledCount: 0,
        snoozedCount: 0,
        snoozedShelfHeaderIndex: null,
        settledCount: 0,
        settledShelfHeaderIndex: null,
        nextSnoozeWakeAt: null,
      };
    // Settled threads are live shells; archived threads keep their original
    // "hidden from lists" meaning.
    return buildThreadListV2Items({
      threads: props.threads.filter((thread) => thread.archivedAt === null),
      environmentId: props.selectedEnvironmentId,
      projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      settledLimit: settledVisibleCount,
      now: new Date().toISOString(),
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey: null,
    });
  }, [
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
    threadListV2Enabled,
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
            pendingTask.message.environmentId === props.selectedEnvironmentId) &&
          (v2ScopedProjectKeys === null ||
            v2ScopedProjectKeys.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
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
      }),
    [settledShelfExpanded, snoozedShelfExpanded, threadListV2Layout, v2PendingTasks],
  );

  const renderV2Item = useCallback(
    ({ item, index }: { readonly item: ThreadListV2ListItem; readonly index: number }) => {
      const nextItem = threadListV2Items[index + 1];
      const showTrailingDivider =
        nextItem?.type === "v2-thread" ||
        (nextItem?.type === "v2-pending" && !nextItem.showPendingDivider);
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.message.environmentId,
          item.pendingTask.creation.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.message.environmentId]
                    ?.environmentLabel ?? null)
                : null
            }
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={!shelfPreferencesLoaded}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={!shelfPreferencesLoaded}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      const thread = item.item.thread;
      return (
        <ThreadListV2Row
          thread={thread}
          variant={item.item.variant}
          snoozed={item.item.snoozed}
          pinned={item.item.pinned}
          snoozePresetMinute={nowMinute}
          snoozeWakeLabelText={item.snoozeWakeLabelText}
          showTrailingDivider={showTrailingDivider}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          projectTitle={v2ProjectTitleByProjectKey.get(
            scopedProjectKey(thread.environmentId, thread.projectId),
          )}
          providerDriver={
            serverConfigs
              .get(thread.environmentId)
              ?.providers.find(
                (provider) =>
                  provider.instanceId ===
                  (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
              )?.driver ?? null
          }
          environmentLabel={
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
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
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={handleSettleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          pinReorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
          canMovePinnedUp={arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`) > 0}
          canMovePinnedDown={(() => {
            const index = arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`);
            return index !== -1 && index < arrangedPinnedKeys.length - 1;
          })()}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onMovePinnedThread={handleMovePinnedThread}
          projectCwd={
            projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
        />
      );
    },
    [
      handleDeleteThread,
      arrangedPinnedKeys,
      handleMovePinnedThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      pinningEnvironmentIds,
      pinReorderEnvironmentIds,
      projectByKey,
      projectCwdByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.savedConnectionsById,
      serverConfigs,
      shelfPreferencesLoaded,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threadListV2Items,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleSettledShelf,
      toggleSnoozedShelf,
      v2ProjectTitleByProjectKey,
      props.searchQuery,
      nowMinute,
    ],
  );
  const v2KeyExtractor = useCallback((item: ThreadListV2ListItem) => item.key, []);

  // FlatList treats a changed extraData identity as "re-render every visible
  // row", so an inline object literal would invalidate all rows on every
  // HomeScreen render.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      serverConfigs,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      projectByKey,
      projectCwdByKey,
      props.searchQuery,
      props.savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
      v2ProjectTitleByProjectKey,
    ],
  );

  const extraData = useMemo(
    () => ({
      projectCwdByKey,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      threadSearchMatchByKey,
    }),
    [projectCwdByKey, props.savedConnectionsById, props.searchQuery, threadSearchMatchByKey],
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<HomeListItem>) => {
      switch (item.type) {
        case "header":
          return (
            <ThreadListGroupHeader
              variant="compact"
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              // Aggregated groups (same repo across machines) have no single
              // target project, and `pending-project:` groups hold a placeholder
              // built from queued-task metadata rather than a real project shell,
              // so the quick new-thread button is single-real-project only.
              newThreadTarget={item.group.newThreadTarget}
              onNewThread={props.onNewThreadInProject}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          );
        case "pending-task":
          return (
            <PendingTaskListRow
              variant="compact"
              pendingTask={item.pendingTask}
              environmentLabel={
                props.savedConnectionsById[item.pendingTask.message.environmentId]
                  ?.environmentLabel ?? null
              }
              isLast={item.isLast}
              onSelectPendingTask={props.onSelectPendingTask}
              onDeletePendingTask={props.onDeletePendingTask}
            />
          );
        case "thread": {
          const thread = item.thread;
          return (
            <ThreadListRow
              variant="compact"
              thread={thread}
              environmentLabel={
                props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
              }
              projectCwd={
                projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                null
              }
              isLast={item.isLast}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              onArchiveThread={props.onArchiveThread}
              onDeleteThread={props.onDeleteThread}
              onRegenerateThreadTitle={handleRegenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              onSelectThread={props.onSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
            />
          );
        }
        case "show-more":
          return (
            <ThreadListShowMoreRow
              variant="compact"
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          );
      }
    },
    [
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleRegenerateThreadTitle,
      projectCwdByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onDeleteThread,
      props.onNewThreadInProject,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.searchQuery,
      props.savedConnectionsById,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      updateGroupDisplay,
    ],
  );

  const keyExtractor = useCallback((item: HomeListItem) => item.key, []);

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so the v1 check already covers v2.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const hasResults = projectGroups.length > 0;
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
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
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
            variant="plain"
          />
          {emptyState.loading ? (
            <View className="mt-4 items-center">
              <ActivityIndicator colorClassName={"accent-icon-muted"} />
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  const listHeader = Platform.OS === "ios" ? null : <HomeTopContentSpacer />;

  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface).
  const v2ListHeader = listHeader;

  const listEmpty = !hasResults ? (
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
    ) : selectedProjectScope !== null ? (
      <EmptyState
        title={`No threads in ${selectedProjectScope.title}`}
        detail="Choose another project or create a new task."
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
      />
    ) : (
      <EmptyState title="No threads yet" detail="Create a task to start a new coding session." />
    )
  ) : null;
  // Self-contained: v1's listEmpty keys off projectGroups, which ignores the
  // v2 project scope, so it can be null (results elsewhere) while this list
  // is empty. Snoozed threads need no special empty state: their shelf header
  // is a list row even while collapsed.
  const v2ListEmpty =
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or create a new task."
      />
    ) : (
      listEmpty
    );

  if (threadListV2Enabled) {
    return (
      <View className="flex-1 bg-screen">
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <FlatList
            data={threadListV2Items}
            renderItem={renderV2Item}
            keyExtractor={v2KeyExtractor}
            extraData={v2ExtraData}
            ListHeaderComponent={v2ListHeader}
            ListFooterComponent={
              settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${Math.min(threadListV2Layout.hiddenSettledCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
                  onPress={showMoreSettled}
                  className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    Show more ({threadListV2Layout.hiddenSettledCount} settled hidden)
                  </Text>
                </Pressable>
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
                  : Math.max(insets.bottom, 16) + 88,
            }}
          />
        </SwipeableScrollGateProvider>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      {/* Sticky headers are deliberately not wired up: LegendList's JS sticky
          implementation mispositions pinned headers at mount under iOS
          automatic content insets (headers render one nav-inset too low until
          the first scroll event) and blanks non-pinned headers after
          collapse/expand data changes. The flattened layout still exposes
          `stickyHeaderIndices` if this gets revisited. */}
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <LegendList
          ref={listRef}
          data={listLayout.items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          itemsAreEqual={homeListItemsAreEqual}
          drawDistance={500}
          estimatedItemSize={ESTIMATED_THREAD_ROW_HEIGHT}
          extraData={extraData}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
          contentInsetAdjustmentBehavior={NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          recycleItems
          scrollEventThrottle={16}
          contentContainerStyle={{
            // Android reserves room for the floating new-task FAB
            // (56 button + 16 gap + bottom inset). Pre-glass iOS shows a
            // standard 44pt bottom toolbar that overlays the list and is not
            // reflected in insets while contentInsetAdjustmentBehavior is
            // "never".
            paddingBottom:
              Platform.OS === "ios"
                ? Math.max(insets.bottom, 24) + 24 + iosBottomToolbarClearance
                : Math.max(insets.bottom, 16) + 88,
          }}
          scrollIndicatorInsets={
            Platform.OS === "ios"
              ? {
                  bottom: Math.max(insets.bottom, 16) + 24 + iosBottomToolbarClearance,
                  top: 0,
                }
              : undefined
          }
        />
      </SwipeableScrollGateProvider>
    </View>
  );
}
