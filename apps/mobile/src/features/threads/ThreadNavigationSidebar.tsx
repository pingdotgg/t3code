import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import type { ColorValue, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Pressable, StyleSheet, TextInput, View, useColorScheme } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { StatusPill } from "../../components/StatusPill";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
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
import { buildHomeThreadGroups } from "../home/homeThreadList";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { useThreadListActions } from "../home/useThreadListActions";
import { WorkspaceConnectionStatus } from "../home/WorkspaceConnectionStatus";
import { shouldShowWorkspaceConnectionStatus } from "../home/workspace-connection-status";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { threadStatusTone } from "./threadPresentation";

const SIDEBAR_STICKY_HEADER_HEIGHT = 94;
const SIDEBAR_STICKY_HEADER_FADE_HEIGHT = 38;
const IOS_SYSTEM_BLUE_DARK = "#0A84FF";
const IOS_SYSTEM_BLUE_LIGHT = "#007AFF";
const IOS_SEARCH_FILL_DARK = "rgba(118, 118, 128, 0.24)";
const IOS_SEARCH_FILL_LIGHT = "rgba(118, 118, 128, 0.12)";
const IOS_SELECTED_FOREGROUND = "#FFFFFF";
const IOS_SELECTED_MUTED_FOREGROUND = "rgba(255, 255, 255, 0.78)";

const ThreadNavigationRow = memo(function ThreadNavigationRow(props: {
  readonly backgroundColor: ColorValue;
  readonly foregroundColor: ColorValue;
  readonly fullSwipeWidth: number;
  readonly mutedColor: ColorValue;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly pressedBackgroundColor: ColorValue;
  readonly selected: boolean;
  readonly selectedBackgroundColor: ColorValue;
  readonly selectedForegroundColor: ColorValue;
  readonly selectedMutedColor: ColorValue;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const [hovered, setHovered] = useState(false);
  const {
    backgroundColor,
    foregroundColor,
    fullSwipeWidth,
    mutedColor,
    onArchiveThread,
    onDeleteThread,
    onSelectThread,
    onSwipeableClose,
    onSwipeableWillOpen,
    pressedBackgroundColor,
    selected,
    selectedBackgroundColor,
    selectedForegroundColor,
    selectedMutedColor,
    simultaneousSwipeGesture,
    thread,
    environmentLabel,
  } = props;
  const handleArchive = useCallback(() => {
    onArchiveThread(thread);
  }, [onArchiveThread, thread]);
  const handleDelete = useCallback(() => {
    onDeleteThread(thread);
  }, [onDeleteThread, thread]);
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );
  const threadActions = useMemo<MenuAction[]>(
    () => [
      { id: "archive", title: "Archive", image: "archivebox" },
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
    [],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete],
  );
  const subtitle = [environmentLabel, thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  const statusTone = threadStatusTone(thread);
  const displayedStatusTone = selected
    ? {
        ...statusTone,
        pillClassName: "bg-white/20",
        textClassName: "text-white",
      }
    : statusTone;

  return (
    <ThreadSwipeable
      backgroundColor={backgroundColor}
      containerStyle={styles.threadRowContainer}
      enableTrackpadSwipe
      fullSwipeWidth={fullSwipeWidth}
      onDelete={handleDelete}
      onSwipeableClose={onSwipeableClose}
      onSwipeableWillOpen={onSwipeableWillOpen}
      primaryAction={primaryAction}
      simultaneousWithExternalGesture={simultaneousSwipeGesture}
      threadTitle={thread.title}
    >
      {() => (
        <View
          style={[
            styles.threadRow,
            { backgroundColor: selected ? selectedBackgroundColor : backgroundColor },
          ]}
        >
          <Pressable
            accessibilityHint="Opens the thread"
            accessibilityLabel={thread.title}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            onPress={() => onSelectThread(thread)}
            style={({ pressed }) => [
              styles.threadSelectionTarget,
              {
                backgroundColor: pressed || hovered ? pressedBackgroundColor : "transparent",
                cursor: "pointer",
              },
            ]}
          >
            <View style={styles.threadText}>
              <Text
                className="text-base font-t3-medium"
                numberOfLines={1}
                style={{ color: selected ? selectedForegroundColor : foregroundColor }}
              >
                {thread.title}
              </Text>
              <View style={styles.threadMetadata}>
                {subtitle.length > 0 ? (
                  <Text
                    className="min-w-0 flex-1 text-xs"
                    numberOfLines={1}
                    style={{ color: selected ? selectedMutedColor : mutedColor }}
                  >
                    {subtitle.join(" · ")}
                  </Text>
                ) : null}
                <Text
                  className="text-xs"
                  numberOfLines={1}
                  style={{ color: selected ? selectedMutedColor : mutedColor }}
                >
                  {relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
                </Text>
              </View>
            </View>
            <StatusPill {...displayedStatusTone} size="compact" />
          </Pressable>
          <ControlPillMenu actions={threadActions} onPressAction={handleMenuAction}>
            <Pressable
              accessibilityLabel={`Actions for ${thread.title}`}
              accessibilityRole="button"
              hitSlop={6}
              style={({ pressed }) => [
                styles.moreButton,
                { backgroundColor: pressed ? pressedBackgroundColor : "transparent" },
              ]}
            >
              <SymbolView name="ellipsis" size={15} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </ControlPillMenu>
        </View>
      )}
    </ThreadSwipeable>
  );
});

type SidebarListItem =
  | { readonly kind: "section"; readonly key: string; readonly title: string }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: EnvironmentThreadShell;
    };

export function ThreadNavigationSidebar(props: {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onStartNewTask: () => void;
  readonly onRequestVisibility: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const router = useRouter();
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [headerIsOverContent, setHeaderIsOverContent] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const headerIsOverContentRef = useRef(false);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
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
        environmentId: options.selectedEnvironmentId,
        searchQuery,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options, projects, searchQuery, threads],
  );
  const listItems = useMemo<ReadonlyArray<SidebarListItem>>(
    () =>
      groups.flatMap((group) => [
        { kind: "section" as const, key: `section:${group.key}`, title: group.title },
        ...group.threads.map((thread) => ({
          kind: "thread" as const,
          key: scopedThreadKey(thread.environmentId, thread.id),
          thread,
        })),
      ]),
    [groups],
  );
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
  const selectedBackgroundColor =
    colorScheme === "dark" ? IOS_SYSTEM_BLUE_DARK : IOS_SYSTEM_BLUE_LIGHT;
  const selectedForegroundColor = IOS_SELECTED_FOREGROUND;
  const selectedMutedColor = IOS_SELECTED_MUTED_FOREGROUND;
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const listThemeKey = `${colorScheme}:${String(backgroundColor)}:${String(selectedBackgroundColor)}`;
  const listExtraData = `${listThemeKey}:${props.selectedThreadKey ?? ""}`;
  const headerFadeColor = String(backgroundColor);
  const topListInset = insets.top + SIDEBAR_STICKY_HEADER_HEIGHT - 6;
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
  const focusSearch = useCallback(() => {
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(() => searchInputRef.current?.focus(), 240);
    } else {
      searchInputRef.current?.focus();
    }
    return true;
  }, [props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) => {
      if (item.kind === "section") {
        return (
          <Text
            className="text-xs font-t3-bold"
            numberOfLines={1}
            style={[styles.sectionTitle, { color: mutedColor }]}
          >
            {item.title}
          </Text>
        );
      }
      const thread = item.thread;
      return (
        <View style={styles.threadItem}>
          <ThreadNavigationRow
            key={`${item.key}:${listThemeKey}`}
            backgroundColor={backgroundColor}
            foregroundColor={foregroundColor}
            fullSwipeWidth={props.width - 20}
            mutedColor={mutedColor}
            onArchiveThread={archiveThread}
            onDeleteThread={confirmDeleteThread}
            onSelectThread={handleSelectThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            pressedBackgroundColor={pressedBackgroundColor}
            selected={item.key === props.selectedThreadKey}
            selectedBackgroundColor={selectedBackgroundColor}
            selectedForegroundColor={selectedForegroundColor}
            selectedMutedColor={selectedMutedColor}
            simultaneousSwipeGesture={sidebarScrollGesture}
            thread={thread}
            environmentLabel={savedConnectionsById[thread.environmentId]?.environmentLabel ?? null}
          />
        </View>
      );
    },
    [
      archiveThread,
      backgroundColor,
      foregroundColor,
      confirmDeleteThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      pressedBackgroundColor,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      selectedBackgroundColor,
      listThemeKey,
      mutedColor,
      selectedForegroundColor,
      selectedMutedColor,
    ],
  );
  const filterIcon = hasCustomHomeListOptions(options)
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";

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
        <GestureDetector gesture={sidebarScrollGesture}>
          <LegendList
            data={listItems}
            estimatedItemSize={58}
            extraData={listExtraData}
            getItemType={(item) => item.kind}
            keyExtractor={(item) => item.key}
            renderItem={renderListItem}
            contentContainerStyle={[
              styles.threadListContent,
              {
                paddingBottom: 16 + insets.bottom,
                paddingTop: showsConnectionStatus ? topListInset + 94 : topListInset,
              },
            ]}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onScroll={handleScroll}
            onScrollBeginDrag={() => openSwipeableRef.current?.close()}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            style={styles.threadList}
            ListEmptyComponent={
              <Text className="px-2 py-4 text-sm" style={{ color: mutedColor }}>
                {catalogState.isLoadingConnections
                  ? "Loading threads…"
                  : searchQuery.trim().length > 0
                    ? "No matching threads"
                    : "No threads yet"}
              </Text>
            }
          />
        </GestureDetector>
      </View>

      <View
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
              height: insets.top + SIDEBAR_STICKY_HEADER_HEIGHT + SIDEBAR_STICKY_HEADER_FADE_HEIGHT,
            },
          ]}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="sidebar-header-wash" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop
                  offset="0%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? (colorScheme === "dark" ? 0.72 : 0.58) : 0}
                />
                <Stop
                  offset="62%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? (colorScheme === "dark" ? 0.52 : 0.42) : 0}
                />
                <Stop
                  offset="86%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? (colorScheme === "dark" ? 0.18 : 0.14) : 0}
                />
                <Stop offset="100%" stopColor={headerFadeColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#sidebar-header-wash)" />
          </Svg>
        </View>
        <View style={styles.header}>
          <Text
            className="flex-1 text-2xl font-t3-bold"
            numberOfLines={1}
            style={{ color: foregroundColor }}
          >
            Threads
          </Text>
          <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
            <SidebarFilterButton accessibilityLabel="Filter and sort threads" icon={filterIcon} />
          </ControlPillMenu>
          <SidebarHeaderActions
            onOpenSettings={props.onOpenSettings}
            onStartNewTask={props.onStartNewTask}
          />
        </View>

        <View
          style={[
            styles.searchField,
            {
              backgroundColor: searchBackgroundColor,
              borderColor:
                colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.72)",
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
            onChangeText={setSearchQuery}
            placeholder="Search"
            placeholderTextColor={placeholderColor}
            returnKeyType="search"
            style={[styles.searchInput, { color: foregroundColor }]}
            value={searchQuery}
          />
          <SymbolView name="mic.fill" size={14} tintColor={mutedColor} type="monochrome" />
        </View>

        {showsConnectionStatus ? (
          <View style={styles.connectionStatus}>
            <WorkspaceConnectionStatus
              onPress={() => router.push("/settings/environments")}
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
    height: 44,
    paddingLeft: 14,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  connectionStatus: {
    paddingTop: 10,
    paddingHorizontal: 14,
  },
  searchField: {
    height: 34,
    marginTop: 5,
    marginHorizontal: 12,
    paddingLeft: 9,
    paddingRight: 10,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
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
    fontSize: 15,
  },
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 10,
  },
  sectionTitle: {
    paddingHorizontal: 8,
    paddingBottom: 4,
    paddingTop: 14,
  },
  threadItem: {
    paddingBottom: 4,
  },
  threadRow: {
    minHeight: 58,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 6,
  },
  threadSelectionTarget: {
    minWidth: 0,
    flex: 1,
    alignSelf: "stretch",
    borderRadius: 10,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  threadRowContainer: {
    borderRadius: 10,
    overflow: "hidden",
  },
  threadText: {
    minWidth: 0,
    flex: 1,
    gap: 2,
  },
  threadMetadata: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  moreButton: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
});
