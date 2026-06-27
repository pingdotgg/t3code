import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ColorValue } from "react-native";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
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
import { threadStatusTone } from "./threadPresentation";

const ThreadNavigationRow = memo(function ThreadNavigationRow(props: {
  readonly backgroundColor: ColorValue;
  readonly fullSwipeWidth: number;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly pressedBackgroundColor: ColorValue;
  readonly selected: boolean;
  readonly selectedBackgroundColor: ColorValue;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const [hovered, setHovered] = useState(false);
  const {
    backgroundColor,
    fullSwipeWidth,
    onArchiveThread,
    onDeleteThread,
    onSelectThread,
    onSwipeableClose,
    onSwipeableWillOpen,
    pressedBackgroundColor,
    selected,
    selectedBackgroundColor,
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

  return (
    <ThreadSwipeable
      backgroundColor={backgroundColor}
      containerStyle={styles.threadRowContainer}
      fullSwipeWidth={fullSwipeWidth}
      onDelete={handleDelete}
      onSwipeableClose={onSwipeableClose}
      onSwipeableWillOpen={onSwipeableWillOpen}
      primaryAction={primaryAction}
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
              <Text className="text-base font-t3-medium" numberOfLines={1}>
                {thread.title}
              </Text>
              <View style={styles.threadMetadata}>
                {subtitle.length > 0 ? (
                  <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                    {subtitle.join(" · ")}
                  </Text>
                ) : null}
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
                </Text>
              </View>
            </View>
            <StatusPill {...threadStatusTone(thread)} size="compact" />
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
  const router = useRouter();
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<TextInput>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
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
  const searchBackgroundColor = useThemeColor("--color-subtle-strong");
  const selectedBackgroundColor = useThemeColor("--color-subtle-strong");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
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
            style={styles.sectionTitle}
            className="text-xs font-t3-bold text-foreground-muted"
            numberOfLines={1}
          >
            {item.title}
          </Text>
        );
      }
      const thread = item.thread;
      return (
        <View style={styles.threadItem}>
          <ThreadNavigationRow
            backgroundColor={backgroundColor}
            fullSwipeWidth={props.width - 20}
            onArchiveThread={archiveThread}
            onDeleteThread={confirmDeleteThread}
            onSelectThread={handleSelectThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            pressedBackgroundColor={pressedBackgroundColor}
            selected={item.key === props.selectedThreadKey}
            selectedBackgroundColor={selectedBackgroundColor}
            thread={thread}
            environmentLabel={savedConnectionsById[thread.environmentId]?.environmentLabel ?? null}
          />
        </View>
      );
    },
    [
      archiveThread,
      backgroundColor,
      confirmDeleteThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      pressedBackgroundColor,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      selectedBackgroundColor,
    ],
  );

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
          paddingTop: insets.top,
        },
      ]}
    >
      <View style={styles.header}>
        <Text className="flex-1 text-2xl font-t3-bold" numberOfLines={1}>
          Threads
        </Text>
        <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
          <Pressable
            accessibilityLabel="Filter and sort threads"
            accessibilityRole="button"
            hitSlop={4}
            style={({ pressed }) => [
              styles.headerButton,
              { backgroundColor: pressed ? pressedBackgroundColor : "transparent" },
            ]}
          >
            <SymbolView
              name={
                hasCustomHomeListOptions(options)
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle"
              }
              size={18}
              tintColor={mutedColor}
              type="monochrome"
            />
          </Pressable>
        </ControlPillMenu>
        <SidebarHeaderActions
          onOpenSettings={props.onOpenSettings}
          onStartNewTask={props.onStartNewTask}
        />
      </View>

      {shouldShowWorkspaceConnectionStatus(catalogState) ? (
        <View style={styles.connectionStatus}>
          <WorkspaceConnectionStatus
            onPress={() => router.push("/settings/environments")}
            state={catalogState}
            variant="sidebar"
          />
        </View>
      ) : null}

      <View style={[styles.searchField, { backgroundColor: searchBackgroundColor }]}>
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
      </View>

      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        <LegendList
          data={listItems}
          estimatedItemSize={58}
          getItemType={(item) => item.kind}
          keyExtractor={(item) => item.key}
          renderItem={renderListItem}
          contentContainerStyle={styles.threadListContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => openSwipeableRef.current?.close()}
          showsVerticalScrollIndicator={false}
          style={styles.threadList}
          ListEmptyComponent={
            <Text className="px-2 py-4 text-sm text-foreground-muted">
              {searchQuery.trim().length > 0 ? "No matching threads" : "No threads yet"}
            </Text>
          }
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    height: 44,
    paddingLeft: 18,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  connectionStatus: {
    paddingTop: 10,
  },
  searchField: {
    height: 36,
    marginTop: 6,
    marginHorizontal: 14,
    paddingLeft: 10,
    paddingRight: 5,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  searchInput: {
    flex: 1,
    height: 36,
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
    paddingTop: 16,
    paddingBottom: 16,
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
