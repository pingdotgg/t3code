import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { EmptyState } from "../../components/EmptyState";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "../threads/thread-list-items";
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
import { buildHomeThreadGroups, type HomeProjectSortOrder } from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { WorkspaceConnectionStatus } from "./WorkspaceConnectionStatus";
import { shouldShowWorkspaceConnectionStatus } from "./workspace-connection-status";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  readonly onAddConnection: () => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

const ESTIMATED_THREAD_ROW_HEIGHT = 72;
/** Height of the floating custom header on non-iOS platforms. */
const CUSTOM_HEADER_HEIGHT = 78;

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

function HomeTopContentSpacer(props: { readonly topInset: number }) {
  return <View style={{ height: props.topInset + CUSTOM_HEADER_HEIGHT }} />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const insets = useSafeAreaInsets();
  const accentColor = useThemeColor("--color-icon-muted");

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

  const projectGroups = useMemo(
    () =>
      buildHomeThreadGroups({
        projects: props.projects,
        threads: props.threads,
        pendingTasks: props.pendingTasks,
        environmentId: props.selectedEnvironmentId,
        searchQuery: props.searchQuery,
        projectSortOrder: props.projectSortOrder,
        threadSortOrder: props.threadSortOrder,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [
      props.pendingTasks,
      props.projectGroupingMode,
      props.projects,
      props.projectSortOrder,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threadSortOrder,
      props.threads,
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

  const extraData = useMemo(
    () => ({ savedConnectionsById: props.savedConnectionsById, projectCwdByKey }),
    [props.savedConnectionsById, projectCwdByKey],
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
              onArchiveThread={props.onArchiveThread}
              onDeleteThread={props.onDeleteThread}
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
      projectCwdByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onDeleteThread,
      props.onNewThreadInProject,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.savedConnectionsById,
      updateGroupDisplay,
    ],
  );

  const keyExtractor = useCallback((item: HomeListItem) => item.key, []);

  /* Empty states */
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const hasResults = projectGroups.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  const shouldShowConnectionStatus = shouldShowWorkspaceConnectionStatus(props.catalogState);
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });
  const connectionStatus =
    shouldShowConnectionStatus && Platform.OS !== "ios" ? (
      <View
        className="absolute left-0 right-0 items-center"
        style={{ bottom: Math.max(insets.bottom, 18) + 76 }}
      >
        <WorkspaceConnectionStatus state={props.catalogState} onPress={props.onOpenEnvironments} />
      </View>
    ) : null;

  if (!hasAnyThreads) {
    return (
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
        style={{
          paddingBottom: Math.max(insets.bottom, 24),
          paddingTop: Platform.OS === "ios" ? insets.top + 72 : insets.top,
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
              <ActivityIndicator color={accentColor} />
            </View>
          ) : null}
        </View>
        {connectionStatus}
      </View>
    );
  }

  const listHeader = (
    <>
      {Platform.OS === "ios" ? null : <HomeTopContentSpacer topInset={insets.top} />}

      {shouldShowConnectionStatus && Platform.OS === "ios" ? (
        <View className="pb-4">
          <WorkspaceConnectionStatus
            state={props.catalogState}
            onPress={props.onOpenEnvironments}
            variant="sidebar"
          />
        </View>
      ) : null}
    </>
  );

  const listEmpty = !hasResults ? (
    hasSearchQuery ? (
      <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
      />
    ) : (
      <EmptyState title="No threads yet" detail="Create a task to start a new coding session." />
    )
  ) : null;

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
          automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          recycleItems
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingBottom: Platform.OS === "ios" ? Math.max(insets.bottom, 24) + 24 : 24,
          }}
          scrollIndicatorInsets={
            Platform.OS === "ios"
              ? {
                  bottom: Math.max(insets.bottom, 16) + 24,
                  top: 0,
                }
              : undefined
          }
        />
      </SwipeableScrollGateProvider>
      {connectionStatus}
    </View>
  );
}
