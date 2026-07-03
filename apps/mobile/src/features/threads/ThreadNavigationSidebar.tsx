import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Platform, StyleSheet, TextInput, View, useColorScheme } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import {
  hasCustomHomeListOptions,
  PROJECT_GROUPING_OPTIONS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
  useHomeListOptions,
} from "../home/home-list-options";
import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "../home/homeListItems";
import { buildHomeThreadGroups } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import { WorkspaceConnectionStatus } from "../home/WorkspaceConnectionStatus";
import { shouldShowWorkspaceConnectionStatus } from "../home/workspace-connection-status";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "./thread-list-items";

/**
 * Shared capsule behind the sidebar header buttons — a native liquid-glass
 * surface on iOS 26+, a tinted pill everywhere else.
 */
function SidebarHeaderButtonGroup(props: {
  readonly children: ReactNode;
  readonly colorScheme: "light" | "dark";
}) {
  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        colorScheme={props.colorScheme}
        effect="regular"
        interactive
        style={styles.headerButtonGroup}
      >
        {props.children}
      </LiquidGlassView>
    );
  }

  return (
    <View
      style={[
        styles.headerButtonGroup,
        props.colorScheme === "dark"
          ? { backgroundColor: "rgba(118,118,128,0.24)", borderColor: "rgba(255,255,255,0.08)" }
          : { backgroundColor: "rgba(255,255,255,0.72)", borderColor: "rgba(0,0,0,0.08)" },
        { borderWidth: StyleSheet.hairlineWidth },
      ]}
    >
      {props.children}
    </View>
  );
}

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;
const SIDEBAR_STICKY_HEADER_FADE_HEIGHT = 44;
const IOS_SEARCH_FILL_DARK = "rgba(118, 118, 128, 0.24)";
const IOS_SEARCH_FILL_LIGHT = "rgba(118, 118, 128, 0.12)";
const SIDEBAR_HEADER_WASH_OPACITY = {
  dark: [0.22, 0.14, 0.04],
  light: [0.46, 0.3, 0.08],
} as const;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");

  return (
    <View
      testID="thread-navigation-sidebar"
      style={[
        styles.container,
        {
          width: props.width,
          backgroundColor,
          borderRightColor: borderColor,
          borderRightWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [headerIsOverContent, setHeaderIsOverContent] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const headerIsOverContentRef = useRef(false);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options,
    setSelectedEnvironmentId,
    setProjectGroupingMode,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const groups = useMemo(
    () =>
      buildHomeThreadGroups({
        projects,
        threads,
        pendingTasks,
        environmentId: options.selectedEnvironmentId,
        searchQuery: props.searchQuery,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options, pendingTasks, projects, props.searchQuery, threads],
  );
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const updateGroupDisplay = useCallback((key: string, action: HomeGroupDisplayAction) => {
    setGroupDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(
        key,
        nextGroupDisplayState(previous.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action),
      );
      return next;
    });
  }, []);
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const listLayout = useMemo(
    () =>
      buildHomeListLayout({
        groups,
        displayStates: groupDisplayStates,
        showAllThreads: hasSearchQuery,
      }),
    [groups, groupDisplayStates, hasSearchQuery],
  );
  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [projects]);
  const showsConnectionStatus = shouldShowWorkspaceConnectionStatus(catalogState);
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            subtitle: "Show threads from every environment",
            state: options.selectedEnvironmentId === null ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              options.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      {
        id: "project-sort",
        title: "Sort projects",
        subactions: PROJECT_SORT_OPTIONS.map((option) => ({
          id: `project-sort:${option.value}`,
          title: option.label,
          state: options.projectSortOrder === option.value ? "on" : "off",
        })),
      },
      {
        id: "thread-sort",
        title: "Sort threads",
        subactions: THREAD_SORT_OPTIONS.map((option) => ({
          id: `thread-sort:${option.value}`,
          title: option.label,
          state: options.threadSortOrder === option.value ? "on" : "off",
        })),
      },
      {
        id: "project-grouping",
        title: "Group projects",
        subactions: PROJECT_GROUPING_OPTIONS.map((option) => ({
          id: `project-grouping:${option.value}`,
          title: option.label,
          subtitle: option.subtitle,
          state: options.projectGroupingMode === option.value ? "on" : "off",
        })),
      },
    ],
    [environments, options],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        setSelectedEnvironmentId(null);
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
        );
        if (environment) setSelectedEnvironmentId(environment.environmentId);
        return;
      }
      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => `project-sort:${option.value}` === event,
      );
      if (projectSort) {
        setProjectSortOrder(projectSort.value);
        return;
      }
      const threadSort = THREAD_SORT_OPTIONS.find(
        (option) => `thread-sort:${option.value}` === event,
      );
      if (threadSort) {
        setThreadSortOrder(threadSort.value);
        return;
      }
      const grouping = PROJECT_GROUPING_OPTIONS.find(
        (option) => `project-grouping:${option.value}` === event,
      );
      if (grouping) setProjectGroupingMode(grouping.value);
    },
    [
      environments,
      setProjectGroupingMode,
      setProjectSortOrder,
      setSelectedEnvironmentId,
      setThreadSortOrder,
    ],
  );

  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const searchBackgroundColor =
    colorScheme === "dark" ? IOS_SEARCH_FILL_DARK : IOS_SEARCH_FILL_LIGHT;
  const headerFadeColor = String(backgroundColor);
  const headerWashOpacity = SIDEBAR_HEADER_WASH_OPACITY[colorScheme];
  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight = measuredHeaderHeight ?? insets.top + SIDEBAR_STICKY_HEADER_HEIGHT;
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
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
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > 6;
    if (headerIsOverContentRef.current === next) {
      return;
    }
    headerIsOverContentRef.current = next;
    setHeaderIsOverContent(next);
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  const listExtraData = props.selectedThreadKey ?? "";
  const focusSearch = useCallback(() => {
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, [props.nativeChrome, props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListItem = useCallback(
    ({ item }: { readonly item: HomeListItem }) => {
      switch (item.type) {
        case "header":
          return (
            <ThreadListGroupHeader
              variant="sidebar"
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          );
        case "pending-task":
          return (
            <PendingTaskListRow
              variant="sidebar"
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.message.environmentId]?.environmentLabel ??
                null
              }
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "thread": {
          const thread = item.thread;
          return (
            <ThreadListRow
              variant="sidebar"
              thread={thread}
              environmentLabel={
                savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
              }
              projectCwd={
                projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                null
              }
              isLast={item.isLast}
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onArchiveThread={archiveThread}
              onDeleteThread={confirmDeleteThread}
              onSelectThread={handleSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "show-more":
          return (
            <ThreadListShowMoreRow
              variant="sidebar"
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          );
      }
    },
    [
      archiveThread,
      confirmDeletePendingTask,
      confirmDeleteThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      openPendingTask,
      projectCwdByKey,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      sidebarScrollGesture,
      updateGroupDisplay,
    ],
  );
  const filterIcon = hasCustomHomeListOptions(options)
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        selectedEnvironmentId: options.selectedEnvironmentId,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        projectGroupingMode: options.projectGroupingMode,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectSortOrderChange: setProjectSortOrder,
        onThreadSortOrderChange: setThreadSortOrder,
        onProjectGroupingModeChange: setProjectGroupingMode,
      }),
    [
      environments,
      options,
      setProjectGroupingMode,
      setProjectSortOrder,
      setSelectedEnvironmentId,
      setThreadSortOrder,
    ],
  );
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        filterIcon,
        filterMenu,
        onOpenSettings: props.onOpenSettings,
      }),
    [filterIcon, filterMenu, props.onOpenSettings],
  );
  const listEmpty = (
    <Text className="px-2 py-4 text-sm" style={{ color: mutedColor }}>
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : props.searchQuery.trim().length > 0
          ? "No matching threads"
          : "No threads yet"}
    </Text>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          options={{
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              // Keep the search bar pinned under the title — UIKit's default
              // hidesSearchBarWhenScrolling collapses it on scroll.
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View style={styles.container}>
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listLayout.items}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={homeListItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets
                contentInsetAdjustmentBehavior="automatic"
                contentContainerStyle={[
                  styles.threadListContent,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListHeaderComponent={
                  showsConnectionStatus ? (
                    <View style={styles.connectionStatusNative}>
                      <WorkspaceConnectionStatus
                        onPress={props.onOpenEnvironmentSettings}
                        state={catalogState}
                        variant="sidebar"
                      />
                    </View>
                  ) : null
                }
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      style={[
        styles.container,
        {
          width: props.width,
          backgroundColor,
          borderRightColor: borderColor,
          borderRightWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            <LegendList
              data={listLayout.items}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={homeListItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              contentContainerStyle={[
                styles.threadListContent,
                {
                  paddingBottom: 16 + insets.bottom,
                  paddingTop: topListInset,
                },
              ]}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              recycleItems
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.threadList}
              ListEmptyComponent={listEmpty}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>

      <View
        onLayout={handleStickyHeaderLayout}
        pointerEvents="box-none"
        style={[
          styles.stickyHeader,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.stickyHeaderWash,
            {
              height: stickyHeaderHeight + SIDEBAR_STICKY_HEADER_FADE_HEIGHT,
            },
          ]}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="sidebar-header-wash" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop
                  offset="0%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[0] : 0}
                />
                <Stop
                  offset="58%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[1] : 0}
                />
                <Stop
                  offset="88%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[2] : 0}
                />
                <Stop offset="100%" stopColor={headerFadeColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#sidebar-header-wash)" />
          </Svg>
        </View>
        <View style={styles.header}>
          <Text
            className="flex-1 text-[34px] font-t3-bold"
            numberOfLines={1}
            style={{ color: foregroundColor }}
          >
            Threads
          </Text>
          <SidebarHeaderButtonGroup colorScheme={colorScheme}>
            <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
              <SidebarFilterButton
                grouped
                accessibilityLabel="Filter and sort threads"
                icon={filterIcon}
              />
            </ControlPillMenu>
            <SidebarHeaderActions grouped onOpenSettings={props.onOpenSettings} />
          </SidebarHeaderButtonGroup>
        </View>

        <View
          style={[
            styles.searchField,
            {
              backgroundColor: searchBackgroundColor,
            },
          ]}
        >
          <SymbolView name="magnifyingglass" size={15} tintColor={mutedColor} type="monochrome" />
          <TextInput
            ref={searchInputRef}
            accessibilityLabel="Search threads"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={props.onSearchQueryChange}
            placeholder="Search"
            placeholderTextColor={placeholderColor}
            returnKeyType="search"
            className="text-base"
            style={[styles.searchInput, { color: foregroundColor }]}
            value={props.searchQuery}
          />
        </View>

        {showsConnectionStatus ? (
          <View style={styles.connectionStatus}>
            <WorkspaceConnectionStatus
              onPress={props.onOpenEnvironmentSettings}
              state={catalogState}
              variant="sidebar"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  stickyHeader: {
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 4,
  },
  stickyHeaderWash: {
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  header: {
    height: 50,
    paddingLeft: 20,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
  },
  headerButtonGroup: {
    alignItems: "center",
    borderRadius: 22,
    flexDirection: "row",
    overflow: "hidden",
  },
  connectionStatus: {
    paddingTop: 10,
    paddingHorizontal: 14,
  },
  connectionStatusNative: {
    paddingBottom: 8,
    paddingHorizontal: 6,
    paddingTop: 2,
  },
  searchField: {
    height: 38,
    marginTop: 9,
    marginHorizontal: 16,
    paddingLeft: 11,
    paddingRight: 10,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  searchInput: {
    flex: 1,
    height: 34,
    paddingVertical: 0,
    paddingHorizontal: 0,
    fontFamily: "DMSans_400Regular",
  },
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
