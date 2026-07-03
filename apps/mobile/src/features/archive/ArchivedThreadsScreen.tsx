import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useRef, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import type { ArchivedThreadGroup, ArchivedThreadSortOrder } from "./archivedThreadList";

export interface ArchivedThreadsHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

const THREAD_ACTIONS: MenuAction[] = [
  {
    id: "unarchive",
    title: "Unarchive",
    image: "arrow.uturn.backward",
  },
  {
    id: "delete",
    title: "Delete",
    image: "trash",
    attributes: { destructive: true },
  },
];

type ArchivedThreadListItem =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly project: EnvironmentProject;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly isFirst: boolean;
      readonly isLast: boolean;
      readonly thread: EnvironmentThreadShell;
    };

function ArchivedThreadsHeader(props: {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sortOrder: ArchivedThreadSortOrder;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortOrderChange: (sortOrder: ArchivedThreadSortOrder) => void;
}) {
  const { width } = useWindowDimensions();
  const hasCustomFilter = props.selectedEnvironmentId !== null || props.sortOrder !== "newest";
  const usesNativeChrome = Platform.OS === "ios";
  const usesCompactMailToolbar = Platform.OS === "ios" && width < 700;
  const archiveFilterMenu = {
    title: "Archived thread options",
    items: [
      {
        type: "submenu" as const,
        title: "Environment",
        items: [
          {
            type: "action" as const,
            title: "All environments",
            state: props.selectedEnvironmentId === null ? ("on" as const) : ("off" as const),
            onPress: () => props.onEnvironmentChange(null),
          },
          ...props.environments.map((environment) => ({
            type: "action" as const,
            title: environment.label,
            state:
              props.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onEnvironmentChange(environment.environmentId),
          })),
        ],
      },
      {
        type: "submenu" as const,
        title: "Sort by archived date",
        items: [
          {
            type: "action" as const,
            title: "Newest first",
            state: props.sortOrder === "newest" ? ("on" as const) : ("off" as const),
            onPress: () => props.onSortOrderChange("newest"),
          },
          {
            type: "action" as const,
            title: "Oldest first",
            state: props.sortOrder === "oldest" ? ("on" as const) : ("off" as const),
            onPress: () => props.onSortOrderChange("oldest"),
          },
        ],
      },
    ],
  };

  return (
    <>
      {/* Static header config (glass preset + title) lives in Stack.tsx; only
          dynamic toolbar/search wiring is set here. */}
      <NativeStackScreenOptions
        options={{
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  composeButtonId: "archived-refresh",
                  composeSystemImageName: "arrow.clockwise",
                  filterMenu: archiveFilterMenu,
                  filterButtonId: "archived-filter",
                  filterSystemImageName: hasCustomFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onComposePress: props.onRefresh,
                  onSearchTextChange: props.onSearchQueryChange,
                  placeholder: "Search",
                  searchTextChangeId: "archived-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                ...(usesNativeChrome
                  ? {
                      allowToolbarIntegration: true,
                      placement: "integratedButton" as const,
                    }
                  : {
                      placement: "stacked" as const,
                    }),
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: "Search archived threads",
                onChangeText: (event) => {
                  props.onSearchQueryChange(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  props.onSearchQueryChange("");
                },
              },
        }}
      />

      {usesCompactMailToolbar ? null : (
        <NativeHeaderToolbar placement="right">
          {usesNativeChrome ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel="Refresh archived threads"
              icon="arrow.clockwise"
              onPress={props.onRefresh}
              separateBackground
            />
          ) : null}
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter and sort archived threads"
            icon={
              hasCustomFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title="Archived thread options"
          >
            <NativeHeaderToolbar.Menu title="Environment">
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
              >
                <NativeHeaderToolbar.Label>All environments</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            <NativeHeaderToolbar.Menu title="Sort by archived date">
              <NativeHeaderToolbar.Label>Sort by archived date</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sortOrder === "newest"}
                onPress={() => props.onSortOrderChange("newest")}
              >
                <NativeHeaderToolbar.Label>Newest first</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sortOrder === "oldest"}
                onPress={() => props.onSortOrderChange("oldest")}
              >
                <NativeHeaderToolbar.Label>Oldest first</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      )}
    </>
  );
}

function ProjectGroupLabel(props: {
  readonly environmentLabel: string | null;
  readonly project: EnvironmentProject;
}) {
  return (
    <View className="flex-row items-center gap-2.5 px-1 pb-2">
      <ProjectFavicon
        environmentId={props.project.environmentId}
        projectTitle={props.project.title}
        size={18}
        workspaceRoot={props.project.workspaceRoot}
      />
      <Text
        className="flex-1 text-xs font-t3-medium uppercase text-foreground-muted"
        numberOfLines={1}
        style={{ letterSpacing: 0.5 }}
      >
        {props.project.title}
      </Text>
      {props.environmentLabel ? (
        <Text className="max-w-[42%] text-2xs text-foreground-tertiary" numberOfLines={1}>
          {props.environmentLabel}
        </Text>
      ) : null}
    </View>
  );
}

function ArchivedThreadRow(props: {
  readonly environmentLabel: string | null;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onDelete: () => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
  readonly onUnarchive: () => void;
  readonly thread: EnvironmentThreadShell;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const cardColor = useThemeColor("--color-card");
  const iconColor = useThemeColor("--color-icon-subtle");
  const separatorColor = useThemeColor("--color-separator");
  const timestamp = relativeTime(props.thread.archivedAt ?? props.thread.updatedAt);
  const subtitle = [props.environmentLabel, props.thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      if (event.nativeEvent.event === "unarchive") {
        props.onUnarchive();
      } else if (event.nativeEvent.event === "delete") {
        props.onDelete();
      }
    },
    [props.onDelete, props.onUnarchive],
  );

  return (
    <ThreadSwipeable
      backgroundColor={cardColor}
      fullSwipeWidth={windowWidth - 32}
      onDelete={props.onDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={{
        accessibilityLabel: `Unarchive ${props.thread.title}`,
        icon: "arrow.uturn.backward",
        label: "Unarchive",
        onPress: props.onUnarchive,
      }}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={props.thread.title}
    >
      {() => (
        <View
          className="flex-row items-center gap-3 bg-card px-4 py-3"
          style={{
            borderBottomColor: separatorColor,
            borderBottomWidth: props.isLast ? 0 : 1,
            borderTopLeftRadius: props.isFirst ? 20 : 0,
            borderTopRightRadius: props.isFirst ? 20 : 0,
            borderBottomLeftRadius: props.isLast ? 20 : 0,
            borderBottomRightRadius: props.isLast ? 20 : 0,
          }}
        >
          <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
            <SymbolView name="archivebox.fill" size={15} tintColor={iconColor} type="monochrome" />
          </View>

          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text
                className="min-w-0 flex-1 text-base font-t3-bold leading-snug text-foreground"
                numberOfLines={1}
              >
                {props.thread.title}
              </Text>
              <Text
                className="text-xs text-foreground-tertiary"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {timestamp}
              </Text>
            </View>
            {subtitle.length > 0 ? (
              <View className="flex-row items-center gap-1.5">
                <SymbolView
                  name="arrow.triangle.branch"
                  size={10}
                  tintColor={iconColor}
                  type="monochrome"
                />
                <Text
                  className="min-w-0 flex-1 text-2xs text-foreground-tertiary"
                  numberOfLines={1}
                  style={{ fontFamily: "monospace" }}
                >
                  {subtitle.join(" · ")}
                </Text>
              </View>
            ) : null}
          </View>

          <ControlPillMenu actions={THREAD_ACTIONS} onPressAction={handleMenuAction}>
            <Pressable
              accessibilityLabel={`Actions for ${props.thread.title}`}
              accessibilityRole="button"
              className="h-8 w-8 items-center justify-center rounded-full active:bg-subtle"
              hitSlop={6}
            >
              <SymbolView name="ellipsis" size={16} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </ControlPillMenu>
        </View>
      )}
    </ThreadSwipeable>
  );
}

function ArchiveError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="rounded-[20px] border border-danger-border bg-danger p-4">
      <Text className="text-base font-t3-bold text-danger-foreground">
        Could not load every archive
      </Text>
      <Text className="mt-1 text-sm text-foreground-muted">{props.message}</Text>
      <Pressable className="mt-3 self-start active:opacity-60" onPress={props.onRetry}>
        <Text className="text-sm font-t3-bold text-danger-foreground">Try again</Text>
      </Pressable>
    </View>
  );
}

export function ArchivedThreadsScreen(props: {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly error: string | null;
  readonly groups: ReadonlyArray<ArchivedThreadGroup>;
  readonly isLoading: boolean;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sortOrder: ArchivedThreadSortOrder;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortOrderChange: (sortOrder: ArchivedThreadSortOrder) => void;
  readonly onUnarchiveThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { onDeleteThread, onUnarchiveThread } = props;
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const archiveScrollGesture = useMemo(() => Gesture.Native(), []);
  const refreshTint = useThemeColor("--color-icon");
  const environmentLabelsById = useMemo(
    () =>
      new Map(
        props.environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [props.environments],
  );
  const listItems = useMemo<ReadonlyArray<ArchivedThreadListItem>>(() => {
    const items: ArchivedThreadListItem[] = [];
    for (const group of props.groups) {
      const environmentLabel = environmentLabelsById.get(group.project.environmentId) ?? null;
      items.push({
        kind: "project",
        key: `${group.key}:project`,
        environmentLabel,
        project: group.project,
      });

      group.threads.forEach((thread, index) => {
        items.push({
          kind: "thread",
          key: `${thread.environmentId}:${thread.id}`,
          environmentLabel,
          isFirst: index === 0,
          isLast: index === group.threads.length - 1,
          thread,
        });
      });
    }
    return items;
  }, [environmentLabelsById, props.groups]);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current && openSwipeableRef.current !== methods) {
      openSwipeableRef.current.close();
    }
    openSwipeableRef.current = methods;
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const isInitialLoad = props.isLoading && props.groups.length === 0 && props.error === null;
  const isFiltered = props.searchQuery.trim().length > 0 || props.selectedEnvironmentId !== null;
  const renderListItem = useCallback(
    ({ item }: { item: ArchivedThreadListItem }) => {
      if (item.kind === "project") {
        return (
          <View className="pt-4">
            <ProjectGroupLabel environmentLabel={item.environmentLabel} project={item.project} />
          </View>
        );
      }

      return (
        <ArchivedThreadRow
          environmentLabel={item.environmentLabel}
          isFirst={item.isFirst}
          isLast={item.isLast}
          onDelete={() => onDeleteThread(item.thread)}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          onUnarchive={() => onUnarchiveThread(item.thread)}
          simultaneousSwipeGesture={archiveScrollGesture}
          thread={item.thread}
        />
      );
    },
    [
      archiveScrollGesture,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      onDeleteThread,
      onUnarchiveThread,
    ],
  );
  const listEmptyComponent = useMemo(() => {
    if (isInitialLoad) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator color={refreshTint} />
          <Text className="mt-3 text-sm text-foreground-muted">Loading archive...</Text>
        </View>
      );
    }

    return (
      <EmptyState
        detail={
          isFiltered
            ? "Try another search or environment."
            : "Threads you archive will appear here."
        }
        title={isFiltered ? "No matching threads" : "No archived threads"}
      />
    );
  }, [isFiltered, isInitialLoad, refreshTint]);

  return (
    <View className="flex-1 bg-sheet">
      <ArchivedThreadsHeader
        environments={props.environments}
        onEnvironmentChange={props.onEnvironmentChange}
        onRefresh={props.onRefresh}
        onSearchQueryChange={props.onSearchQueryChange}
        onSortOrderChange={props.onSortOrderChange}
        selectedEnvironmentId={props.selectedEnvironmentId}
        sortOrder={props.sortOrder}
      />

      <GestureDetector gesture={archiveScrollGesture}>
        <LegendList
          className="flex-1"
          contentContainerStyle={{
            paddingBottom: 32,
            paddingHorizontal: 16,
            paddingTop: 4,
          }}
          contentInsetAdjustmentBehavior="automatic"
          data={listItems}
          estimatedItemSize={62}
          getItemType={(item) => item.kind}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmptyComponent}
          ListHeaderComponent={
            props.error ? <ArchiveError message={props.error} onRetry={props.onRefresh} /> : null
          }
          onScrollBeginDrag={() => openSwipeableRef.current?.close()}
          refreshControl={
            <RefreshControl
              onRefresh={props.onRefresh}
              refreshing={props.isLoading && !isInitialLoad}
              tintColor={String(refreshTint)}
            />
          }
          renderItem={renderListItem}
          showsVerticalScrollIndicator={false}
        />
      </GestureDetector>
    </View>
  );
}
