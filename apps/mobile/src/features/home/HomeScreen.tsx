import { useActiveNewTask } from "../../state/active-new-task";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import type { ThreadMoveDestination } from "../threads/threadOrder";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { THREAD_SIDEBAR_ROW_LAYOUT } from "../threads/threadListAnimations";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { use, useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Platform,
  ScrollView,
  useWindowDimensions,
  View,
  type ScrollViewProps,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import {
  ANDROID_READING_MAX_WIDTH,
  deriveCenteredContentHorizontalPadding,
} from "../../lib/layout";
import { EmptyState } from "../../components/ui/EmptyState";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { nativeHeaderScrollEdgeEffects } from "../../native/scrollEdgeEffects";
import {
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useThreadSearch } from "../../state/queries";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { useThreadListSearchMatches } from "../threads/useThreadListSearchMatches";
import { useThreadListV2 } from "../threads/useThreadListV2";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
  ThreadListV2WorkingShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import { useOpenThreadPullRequests } from "../threads/use-open-thread-pull-requests";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import {
  threadListV2ListItemsAreEqual,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  buildHomeProjectScopes,
  findHomeProjectScope,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { createSwipeRowActivation } from "./swipe-row-activation";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { useFabScroll } from "./FabScrollContext";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { ThreadListFilters } from "./ThreadListFilters";

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

const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 72;
// Rows away from the viewport skip their swipe actions (see
// swipe-row-activation), so render further ahead: a fast fling then reaches
// rows that are already built instead of rows still being rebuilt.
const THREAD_LIST_V2_DRAW_DISTANCE = 1_000;

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
    detail: "Create a task to start a new coding runtime in one of your connected projects.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

function HomeScrollView(props: ComponentProps<typeof ScrollView>) {
  const primaryColumn = use(NativePrimaryColumnContext);
  if (Platform.OS !== "ios") return <ScrollView {...props} />;

  // Register the scroll view explicitly; layout and header siblings hide it from UIKit.
  return (
    <ScrollViewMarker
      style={{ flex: 1 }}
      scrollEdgeEffects={{
        ...nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version),
        top: Number.parseInt(String(Platform.Version), 10) >= 27 ? "automatic" : "soft",
      }}
    >
      <ScrollView
        {...props}
        // UIKit's scroll-edge material needs the scroll view's own surface color.
        className={cn(props.className, primaryColumn ? "bg-drawer" : "bg-screen")}
      />
    </ScrollViewMarker>
  );
}

function renderHomeScrollView(props: ScrollViewProps) {
  // FlatList clones this with cells and ref; keep the marker inside their actual ScrollView.
  return <HomeScrollView {...props} />;
}

export function HomeScreen(props: HomeScreenProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const workspace = useWorkspaceTabs();
  const [initialScrollOffset] = useState(() => workspace?.getScrollOffset("threads") ?? 0);
  const primaryColumn = use(NativePrimaryColumnContext);
  const contentBackground = primaryColumn ? "bg-drawer" : "bg-screen";
  const containerClassName = cn(
    "flex-1",
    Platform.OS === "android" ? "bg-header" : contentBackground,
  );
  const columnMetrics = useNativeColumnLayoutMetrics();
  const activeNewTask = useActiveNewTask();
  const selectedThreadKey = activeNewTask ? null : (primaryColumn?.selectedThreadKey ?? null);
  const fullSwipeWidth = primaryColumn && columnMetrics ? columnMetrics.width - 20 : undefined;
  const queuedThreadKeys = useQueuedThreadKeys();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const homeScrollGesture = useNativeGesture();
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const screenMetrics = useNativeLayoutMetrics();
  const contentSideInsets = usesNativeWorkspaceColumns
    ? (columnMetrics ?? screenMetrics)?.safeArea
    : undefined;
  // Wide Android lists need reading-width gutters to clear edges and camera cutouts.
  const { width: windowWidth } = useWindowDimensions();
  const androidListGutter =
    Platform.OS === "android"
      ? deriveCenteredContentHorizontalPadding({
          viewportWidth: windowWidth,
          maxContentWidth: ANDROID_READING_MAX_WIDTH,
          minimumPadding: 0,
        })
      : 0;
  const iosBottomClearance = Math.max(
    columnMetrics?.safeArea.bottom ?? insets.bottom,
    24,
    workspace?.bottomClearance ?? 0,
  );
  const searchEnvironmentIds =
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
        : [];
  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  };

  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };

  const handleScrollBeginDrag = () => {
    openSwipeableRef.current?.close();
  };
  const openThreadPullRequests = useOpenThreadPullRequests();
  const handleOpenThreadPullRequests = (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => {
    openSwipeableRef.current?.close();
    openThreadPullRequests(thread, pr);
  };
  const onFabScroll = useFabScroll();
  const listRef = useRef<LegendListRef>(null);
  const searchMode = workspace?.state.tabs.threads.searchMode;
  const restoredOffset = workspace?.state.tabs.threads.scrollOffset;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the thread list's saved scroll offset through the list ref when search goes back to resting
  useEffect(() => {
    if (searchMode !== "resting" || restoredOffset === undefined) return;
    listRef.current?.scrollToOffset({
      offset: restoredOffset - (Platform.OS === "ios" ? insets.top : 0),
      animated: false,
    });
  }, [searchMode, insets.top, restoredOffset]);
  const swipeRowActivation = createSwipeRowActivation();
  const activateVisibleRows = (rows: ReadonlyArray<ThreadListV2ListItem>) => {
    const state = listRef.current?.getState();
    if (state === undefined || !(state.end >= 0)) return;
    swipeRowActivation.activate(
      rows.slice(Math.max(0, state.start - 2), state.end + 3).map((row) => row.key),
    );
  };
  // Status-bar, accessibility and programmatic scrolls bypass the gate; activate visible rows after settling.
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the row activation timer on unmount
  useEffect(() => () => clearTimeout(activationTimerRef.current), []);
  const handleListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onFabScroll?.(event);
    if (workspace)
      workspace.recordScrollOffset(
        "threads",
        Math.max(0, event.nativeEvent.contentOffset.y + (Platform.OS === "ios" ? insets.top : 0)),
      );
    clearTimeout(activationTimerRef.current);
    activationTimerRef.current = setTimeout(
      () => activateVisibleRows(listRef.current?.getState().data ?? []),
      200,
    );
  };
  const trackListTouches = (event: GestureResponderEvent, started: boolean) => {
    const { changedTouches, touches } = event.nativeEvent;
    swipeRowActivation.trackTouches(
      started ? changedTouches.map((touch) => String(touch.identifier)) : [],
      touches.map((touch) => String(touch.identifier)),
    );
  };
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleListScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = buildHomeProjectScopes({
    projects: props.projects,
    environmentId: props.selectedEnvironmentId,
    projectGroupingMode: props.projectGroupingMode,
  });
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectByKey = (() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  })();

  const v2ProjectScopeKey = props.selectedProjectKey;
  // An archived project's filter reads as all projects, matching the filter menu.
  const v2ScopedProjectGroup = findHomeProjectScope(
    pickableProjectGroups(projectScopes),
    v2ProjectScopeKey,
  );
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    props.searchQuery,
    v2ScopedProjectGroup === null
      ? {}
      : { projectIds: v2ScopedProjectGroup.projectRefs.map((ref) => ref.projectId) },
  );
  const threadSearchMatchByKey = useThreadListSearchMatches(props.threads, threadSearch);
  const v2ProjectTitleByProjectKey = new Map(
    projectScopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.title] as const,
      ),
    ),
  );
  const handleSettleThread = props.onSettleThread;
  const handleSnoozeThread = props.onSnoozeThread;
  const handleUnsnoozeThread = props.onUnsnoozeThread;
  const handlePinThread = props.onPinThread;
  const handleMoveThread = props.onMoveThread;
  const handleUnpinThread = props.onUnpinThread;
  const handleSetThreadAutoSettle = props.onSetThreadAutoSettle;
  const handleRegenerateThreadTitle = props.onRegenerateThreadTitle;
  const handleRenameThread = props.onRenameThread;
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const [lastSettledResetKey, setLastSettledResetKey] = useState(settledResetKey);
  if (lastSettledResetKey !== settledResetKey) {
    setLastSettledResetKey(settledResetKey);
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = () =>
    setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT);
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } = useThreadListV2ShelfPreferences();
  const now = useThreadListNow(props.threads);
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozePresetsByEnvironmentId,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = listEnvironments;
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const pendingOrder = usePendingThreadOrder();
  const {
    layout: threadListV2Layout,
    items: threadListV2Items,
    contentOnlyThreadKeys,
    olderSettledShelf,
  } = useThreadListV2({
    threads: props.threads,
    pendingTasks: props.pendingTasks,
    environmentId: props.selectedEnvironmentId,
    projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
    searchQuery: props.searchQuery,
    searchMatches: threadSearchMatchByKey,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    queuedThreadKeys,
    settledLimit: settledVisibleCount,
    now,
    pendingOrder,
    shelfPreferencesLoaded,
    workingShelfEnabled,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey,
  });
  // Called as `props.onSelectThread(...)`, the compiler would cache this handler on the whole
  // props object, which is new on every render of Home's parent.
  const { onSelectThread } = props;
  // A row listed for a message match opens the thread at that message, by
  // tap or by shortcut.
  const selectThread = (thread: EnvironmentThreadShell) => {
    const key = threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
    const messageId = contentOnlyThreadKeys.has(key)
      ? threadSearchMatchByKey.get(key)?.messageId
      : undefined;
    if (messageId) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
    }
    onSelectThread(thread);
  };
  useThreadJumpShortcuts(threadListV2Items, selectThread);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the list's visible range after commit to enable swipe gestures on those rows
  useEffect(() => {
    if (swipeEnabled) activateVisibleRows(threadListV2Items);
  }, [activateVisibleRows, swipeEnabled, threadListV2Items]);

  const renderV2Item = ({ item }: { readonly item: ThreadListV2ListItem }) => {
    if (item.type === "v2-pending") {
      const pendingScopeKey = scopedProjectKey(
        item.pendingTask.environmentId,
        item.pendingTask.projectId,
      );
      return (
        <ThreadListV2PendingRow
          pane={primaryColumn ? "sidebar" : "screen"}
          pendingTask={item.pendingTask}
          selected={
            activeNewTask?.pendingKey === item.pendingTask.key ||
            (item.pendingTask.kind === "pending" &&
              scopedThreadKey(item.pendingTask.environmentId, item.pendingTask.message.threadId) ===
                selectedThreadKey)
          }
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
          fullSwipeWidth={fullSwipeWidth}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          simultaneousSwipeGesture={homeScrollGesture}
          activationKey={item.key}
        />
      );
    }
    if (item.type === "v2-working-shelf") {
      return (
        <ThreadListV2WorkingShelfHeader
          count={item.count}
          disabled={item.disabled}
          expanded={item.expanded}
          onToggle={toggleWorkingShelf}
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
        pane={primaryColumn ? "sidebar" : "screen"}
        selected={scopedThreadKey(thread.environmentId, thread.id) === selectedThreadKey}
        fullSwipeWidth={fullSwipeWidth}
        onNewThreadOnBranch={props.onNewThreadOnBranch}
        thread={thread}
        variant={item.item.variant}
        hasQueuedMessages={item.hasQueuedMessages}
        snoozed={item.item.snoozed}
        pinned={item.item.pinned}
        wokeAt={item.item.wokeAt}
        snoozePresetMinute={item.snoozePresetMinute ?? ""}
        snoozeWakeLabelText={item.snoozeWakeLabelText}
        timeLabel={item.timeLabel}
        showTrailingDivider={item.showTrailingDivider}
        project={projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null}
        providerInstance={resolveProviderInstance(thread)}
        providers={providersByEnvironmentId.get(thread.environmentId)}
        environmentLabel={
          Object.keys(props.savedConnectionsById).length > 1
            ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
            : null
        }
        environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
        searchMatch={
          // Only rows listed for their messages show one and open at it.
          contentOnlyThreadKeys.has(
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
          )
            ? threadSearchMatchByKey.get(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )
            : undefined
        }
        searchQuery={threadSearch.query}
        onSelectThread={selectThread}
        onOpenThreadPullRequests={handleOpenThreadPullRequests}
        onDeleteThread={handleDeleteThread}
        onArchiveThread={props.onArchiveThread}
        onRenameThread={handleRenameThread}
        onRegenerateThreadTitle={handleRegenerateThreadTitle}
        titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
        settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
        onSettleThread={handleSettleThread}
        snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
        snoozePresets={snoozePresetsByEnvironmentId.get(thread.environmentId)}
        pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
        autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
        reorderSupported={
          item.item.pinned
            ? pinReorderEnvironmentIds.has(thread.environmentId)
            : !workingShelfEnabled && activeReorderEnvironmentIds.has(thread.environmentId)
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
        simultaneousSwipeGesture={homeScrollGesture}
        activationKey={item.key}
      />
    );
  };
  const v2KeyExtractor = (item: ThreadListV2ListItem) => item.key;

  // extraData changes invalidate every visible row; put the minute clock on items to limit updates.
  const v2ExtraData = {
    activeNewTask,
    projectByKey,
    projectTitleByProjectKey: v2ProjectTitleByProjectKey,
    listEnvironments,
    savedConnectionsById: props.savedConnectionsById,
    searchQuery: props.searchQuery,
    selectedThreadKey,
    threadSearchMatchByKey,
    workingShelfEnabled,
  };

  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) ||
    props.pendingTasks.length > 0 ||
    threadListV2Layout.settledCount > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    return (
      <View className={containerClassName}>
        <View
          className={cn(
            "flex-1 items-center justify-center px-8",
            contentBackground,
            Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
          )}
          style={{
            paddingBottom: Platform.OS === "ios" ? iosBottomClearance : Math.max(insets.bottom, 24),
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
            paddingLeft: 32 + (contentSideInsets?.left ?? 0),
            paddingRight: 32 + (contentSideInsets?.right ?? 0),
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
                  <FloatingActionButton
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
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  const listHeader = Platform.OS === "ios" ? undefined : <HomeTopContentSpacer />;

  const v2ListHeader = (
    <>
      {listHeader}
      {Platform.OS === "ios" && workspace ? (
        <ThreadListFilters
          gutter={primaryColumn ? 8 : 0}
          environments={props.environments}
          projects={pickableProjectGroups(projectScopes).map((scope) => ({
            key: scope.key,
            label: scope.title,
          }))}
          selectedEnvironmentId={props.selectedEnvironmentId}
          selectedProjectKey={props.selectedProjectKey}
          onEnvironmentChange={props.onEnvironmentChange}
          onProjectChange={props.onProjectChange}
        />
      ) : null}
    </>
  );

  const v2ListEmpty =
    hasSearchQuery && threadSearch.isPending ? undefined : hasSearchQuery ? (
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
    <View className={containerClassName}>
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
            : cn("flex-1", contentBackground)
        }
      >
        <SwipeableScrollGateProvider enabled={swipeEnabled} activation={swipeRowActivation}>
          <GestureDetector gesture={homeScrollGesture}>
            <AnimatedLegendList
              itemLayoutAnimation={primaryColumn ? THREAD_SIDEBAR_ROW_LAYOUT : undefined}
              ref={listRef}
              onLoad={() => activateVisibleRows(threadListV2Items)}
              onTouchStart={(event) => trackListTouches(event, true)}
              onTouchEnd={(event) => trackListTouches(event, false)}
              onTouchCancel={(event) => trackListTouches(event, false)}
              renderScrollComponent={Platform.OS === "ios" ? renderHomeScrollView : undefined}
              data={threadListV2Items}
              renderItem={renderV2Item}
              keyExtractor={v2KeyExtractor}
              getItemType={(item) => item.type}
              itemsAreEqual={threadListV2ListItemsAreEqual}
              estimatedItemSize={ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT}
              drawDistance={THREAD_LIST_V2_DRAW_DISTANCE}
              recycleItems
              extraData={v2ExtraData}
              ListHeaderComponent={v2ListHeader}
              ListFooterComponent={
                settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0 ? (
                  <ThreadListV2ShowMoreRow
                    hiddenCount={threadListV2Layout.hiddenSettledCount}
                    {...(olderSettledShelf.loading
                      ? { state: "loading" as const }
                      : olderSettledShelf.failed
                        ? { state: "failed" as const }
                        : {})}
                    onPress={() => {
                      olderSettledShelf.retry();
                      showMoreSettled();
                    }}
                  />
                ) : null
              }
              ListEmptyComponent={v2ListEmpty}
              style={{ flex: 1 }}
              automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
              // UIKit owns the bar's inset, so a minimizing bar and a resized column move
              // the list in the same frame as the bar.
              contentInsetAdjustmentBehavior="automatic"
              contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
              initialScrollOffset={
                initialScrollOffset > 0
                  ? initialScrollOffset - (Platform.OS === "ios" ? insets.top : 0)
                  : undefined
              }
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              scrollEventThrottle={16}
              contentContainerStyle={{
                paddingLeft:
                  (contentSideInsets?.left ?? 0) + (primaryColumn ? 8 : 0) + androidListGutter,
                paddingRight:
                  (contentSideInsets?.right ?? 0) + (primaryColumn ? 8 : 0) + androidListGutter,
                paddingBottom:
                  Platform.OS === "ios"
                    ? iosBottomClearance - (columnMetrics?.safeArea.bottom ?? insets.bottom)
                    : (workspace?.bottomClearance ??
                      Math.max(insets.bottom, 16) +
                        (Platform.OS === "android" ? fabClearance : 88)),
              }}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>
    </View>
  );
}
