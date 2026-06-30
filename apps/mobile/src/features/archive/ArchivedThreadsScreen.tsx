import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useRef } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  THREAD_SWIPE_ACTIONS_WIDTH,
  THREAD_SWIPE_SPRING,
  ThreadSwipeActions,
} from "../home/thread-swipe-actions";
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
  const usesNativeMailToolbar = Platform.OS === "ios" && width < 700;
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
      <Stack.Screen
        options={{
          title: "Archived Threads",
          headerTransparent: usesNativeMailToolbar,
          headerStyle: usesNativeMailToolbar ? { backgroundColor: "transparent" } : undefined,
          headerShadowVisible: usesNativeMailToolbar ? false : undefined,
          unstable_navigationItemStyle: usesNativeMailToolbar ? "editor" : undefined,
          unstable_headerToolbarItems: usesNativeMailToolbar
            ? () => [
                {
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
                  type: "mailSearchToolbar",
                  useFallbackSearchField: true,
                },
              ]
            : undefined,
          headerSearchBarOptions: usesNativeMailToolbar
            ? undefined
            : {
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: "Search archived threads",
                placement: "stacked",
                onChangeText: (event) => {
                  props.onSearchQueryChange(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  props.onSearchQueryChange("");
                },
              },
        }}
      />

      {usesNativeMailToolbar ? null : (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu
            accessibilityLabel="Filter and sort archived threads"
            icon={
              hasCustomFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title="Archived thread options"
          >
            <Stack.Toolbar.Menu title="Environment">
              <Stack.Toolbar.Label>Environment</Stack.Toolbar.Label>
              <Stack.Toolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
              >
                <Stack.Toolbar.Label>All environments</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
              {props.environments.map((environment) => (
                <Stack.Toolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <Stack.Toolbar.Label>{environment.label}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>

            <Stack.Toolbar.Menu title="Sort by archived date">
              <Stack.Toolbar.Label>Sort by archived date</Stack.Toolbar.Label>
              <Stack.Toolbar.MenuAction
                isOn={props.sortOrder === "newest"}
                onPress={() => props.onSortOrderChange("newest")}
              >
                <Stack.Toolbar.Label>Newest first</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                isOn={props.sortOrder === "oldest"}
                onPress={() => props.onSortOrderChange("oldest")}
              >
                <Stack.Toolbar.Label>Oldest first</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
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
  readonly isLast: boolean;
  readonly onDelete: () => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onUnarchive: () => void;
  readonly thread: EnvironmentThreadShell;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const { width: windowWidth } = useWindowDimensions();
  const cardColor = useThemeColor("--color-card");
  const iconColor = useThemeColor("--color-icon-subtle");
  const separatorColor = useThemeColor("--color-separator");
  const fullSwipeThreshold = Math.max(THREAD_SWIPE_ACTIONS_WIDTH + 44, (windowWidth - 32) * 0.58);
  const timestamp = relativeTime(props.thread.archivedAt ?? props.thread.updatedAt);
  const subtitle = [props.environmentLabel, props.thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current && process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);
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
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: cardColor }}
      containerStyle={{ backgroundColor: cardColor }}
      dragOffsetFromRightEdge={8}
      enableTrackpadTwoFingerGesture
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;
        if (swipeableRef.current) {
          props.onSwipeableClose(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen(swipeableRef.current);
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current;
        if (!methods) return;

        props.onSwipeableWillOpen(methods);
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();
          props.onDelete();
        }
      }}
      overshootFriction={1}
      overshootRight
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={cardColor}
          fullSwipeThreshold={fullSwipeThreshold}
          onDelete={props.onDelete}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            accessibilityLabel: `Unarchive ${props.thread.title}`,
            icon: "arrow.uturn.backward",
            label: "Unarchive",
            onPress: props.onUnarchive,
          }}
          swipeableMethods={methods}
          threadTitle={props.thread.title}
          translation={translation}
        />
      )}
      rightThreshold={THREAD_SWIPE_ACTIONS_WIDTH * 0.42}
    >
      <View
        className="flex-row items-center gap-3 bg-card px-4 py-3"
        style={{
          borderBottomColor: separatorColor,
          borderBottomWidth: props.isLast ? 0 : 1,
        }}
      >
        <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
          <SymbolView name="archivebox.fill" size={15} tintColor={iconColor} type="monochrome" />
        </View>

        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text
              className="min-w-0 flex-1 text-base font-t3-bold leading-[20px] text-foreground"
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
    </ReanimatedSwipeable>
  );
}

function ArchiveError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="rounded-[20px] border border-danger-border bg-danger p-4">
      <Text className="text-base font-t3-bold text-danger-foreground">
        Could not load every archive
      </Text>
      <Text className="mt-1 text-sm leading-[18px] text-foreground-muted">{props.message}</Text>
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
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const refreshTint = useThemeColor("--color-icon");
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

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ gap: 20, paddingBottom: 32, paddingHorizontal: 16, paddingTop: 8 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => openSwipeableRef.current?.close()}
        refreshControl={
          <RefreshControl
            onRefresh={props.onRefresh}
            refreshing={props.isLoading && !isInitialLoad}
            tintColor={String(refreshTint)}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {props.error ? <ArchiveError message={props.error} onRetry={props.onRefresh} /> : null}

        {isInitialLoad ? (
          <View className="items-center py-16">
            <ActivityIndicator color={refreshTint} />
            <Text className="mt-3 text-sm text-foreground-muted">Loading archive…</Text>
          </View>
        ) : props.groups.length === 0 ? (
          <EmptyState
            detail={
              isFiltered
                ? "Try another search or environment."
                : "Threads you archive will appear here."
            }
            title={isFiltered ? "No matching threads" : "No archived threads"}
          />
        ) : (
          props.groups.map((group) => {
            const environmentLabel =
              props.environments.find(
                (environment) => environment.environmentId === group.project.environmentId,
              )?.label ?? null;

            return (
              <View key={group.key} collapsable={false}>
                <ProjectGroupLabel environmentLabel={environmentLabel} project={group.project} />
                <View
                  className="overflow-hidden rounded-[20px] bg-card"
                  style={{ borderCurve: "continuous" }}
                >
                  {group.threads.map((thread, index) => (
                    <ArchivedThreadRow
                      key={`${thread.environmentId}:${thread.id}`}
                      environmentLabel={environmentLabel}
                      isLast={index === group.threads.length - 1}
                      onDelete={() => props.onDeleteThread(thread)}
                      onSwipeableClose={handleSwipeableClose}
                      onSwipeableWillOpen={handleSwipeableWillOpen}
                      onUnarchive={() => props.onUnarchiveThread(thread)}
                      thread={thread}
                    />
                  ))}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
