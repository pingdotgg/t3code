import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  TextInput,
  ActivityIndicator,
  FlatList,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import {
  formatArchivedThreadRelativeTime,
  archivedThreadTimestampValue,
  nextArchivedThreadSortState,
  type ArchivedThreadGroup,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
} from "./archivedThreadList";
import { scopedThreadKey } from "../../lib/scopedEntities";

export interface ArchivedThreadsHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

type ArchivedThreadListItem =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly expanded: boolean;
      readonly group: ArchivedThreadGroup;
      readonly isSearching: boolean;
      readonly isBusy: boolean;
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
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sort: ArchivedThreadSortState;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
}) {
  const { width } = useWindowDimensions();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const hasCustomFilter =
    props.selectedEnvironmentId !== null ||
    props.sort.field !== "archivedAt" ||
    props.sort.direction !== "desc";
  const searchIconColor = useThemeColor("--color-icon");
  const searchTextColor = useThemeColor("--color-foreground");
  const usesNativeChrome = Platform.OS === "ios";
  const usesCompactMailToolbar = Platform.OS === "ios" && width < 700;
  const androidFilterActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? ("on" as const) : undefined,
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              props.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : undefined,
          })),
        ],
      },
      {
        id: "sort",
        title: "Sort archived threads",
        subactions: [
          {
            id: "sort:archivedAt:desc",
            title: "Archived: newest first",
            state:
              props.sort.field === "archivedAt" && props.sort.direction === "desc"
                ? ("on" as const)
                : undefined,
          },
          {
            id: "sort:archivedAt:asc",
            title: "Archived: oldest first",
            state:
              props.sort.field === "archivedAt" && props.sort.direction === "asc"
                ? ("on" as const)
                : undefined,
          },
          {
            id: "sort:createdAt:desc",
            title: "Created: newest first",
            state:
              props.sort.field === "createdAt" && props.sort.direction === "desc"
                ? ("on" as const)
                : undefined,
          },
          {
            id: "sort:createdAt:asc",
            title: "Created: oldest first",
            state:
              props.sort.field === "createdAt" && props.sort.direction === "asc"
                ? ("on" as const)
                : undefined,
          },
        ],
      },
    ],
    [props.environments, props.selectedEnvironmentId, props.sort],
  );
  const handleAndroidFilterAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = event.nativeEvent.event;
      if (action === "environment:all") {
        props.onEnvironmentChange(null);
      } else if (action.startsWith("environment:")) {
        props.onEnvironmentChange(action.slice("environment:".length) as EnvironmentId);
      } else if (action.startsWith("sort:")) {
        const [, field, direction] = action.split(":");
        if (
          (field === "archivedAt" || field === "createdAt") &&
          (direction === "asc" || direction === "desc")
        ) {
          props.onSortChange({ field, direction });
        }
      }
    },
    [props.onEnvironmentChange, props.onSortChange],
  );

  if (Platform.OS === "android") {
    // Single header row matching the app's Android chrome (AndroidScreenHeader
    // palette): back chevron, inline search, filter menu.
    return (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <View
          className="border-b border-header-border bg-header px-3 pb-2.5"
          style={{
            paddingTop: Math.max(insets.top, 12),
          }}
        >
          <View className="min-h-12 flex-row items-center gap-2">
            <Pressable
              accessibilityLabel="Navigate up"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => navigation.goBack()}
              className="size-11 items-center justify-center"
            >
              <SymbolView
                name="chevron.left"
                size={24}
                tintColor={searchTextColor}
                type="monochrome"
              />
            </Pressable>
            <View className="min-h-11 flex-1 flex-row items-center gap-2.5 rounded-2xl bg-input px-3.5">
              <SymbolView
                name="magnifyingglass"
                size={17}
                tintColor={searchIconColor}
                type="monochrome"
              />
              <TextInput
                accessibilityLabel="Search archived threads"
                autoCapitalize="none"
                onChangeText={props.onSearchQueryChange}
                value={props.searchQuery}
                placeholder="Search archived threads"
                placeholderTextColorClassName="accent-placeholder"
                className="flex-1 py-2 text-base font-sans text-foreground"
              />
            </View>
            <ControlPillMenu
              actions={androidFilterActions}
              isAnchoredToRight
              onPressAction={handleAndroidFilterAction}
            >
              <Pressable
                accessibilityLabel="Filter and sort archived threads"
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={
                    hasCustomFilter
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={16}
                  tintColor={searchIconColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          </View>
        </View>
      </>
    );
  }
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
        title: "Sort archived threads",
        items: [
          {
            type: "action" as const,
            title: "Archived: newest first",
            state:
              props.sort.field === "archivedAt" && props.sort.direction === "desc"
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onSortChange({ field: "archivedAt", direction: "desc" }),
          },
          {
            type: "action" as const,
            title: "Archived: oldest first",
            state:
              props.sort.field === "archivedAt" && props.sort.direction === "asc"
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onSortChange({ field: "archivedAt", direction: "asc" }),
          },
          {
            type: "action" as const,
            title: "Created: newest first",
            state:
              props.sort.field === "createdAt" && props.sort.direction === "desc"
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onSortChange({ field: "createdAt", direction: "desc" }),
          },
          {
            type: "action" as const,
            title: "Created: oldest first",
            state:
              props.sort.field === "createdAt" && props.sort.direction === "asc"
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onSortChange({ field: "createdAt", direction: "asc" }),
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

            <NativeHeaderToolbar.Menu title="Sort archived threads">
              <NativeHeaderToolbar.Label>Sort archived threads</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sort.field === "archivedAt" && props.sort.direction === "desc"}
                onPress={() => props.onSortChange({ field: "archivedAt", direction: "desc" })}
              >
                <NativeHeaderToolbar.Label>Archived: newest first</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sort.field === "archivedAt" && props.sort.direction === "asc"}
                onPress={() => props.onSortChange({ field: "archivedAt", direction: "asc" })}
              >
                <NativeHeaderToolbar.Label>Archived: oldest first</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sort.field === "createdAt" && props.sort.direction === "desc"}
                onPress={() => props.onSortChange({ field: "createdAt", direction: "desc" })}
              >
                <NativeHeaderToolbar.Label>Created: newest first</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sort.field === "createdAt" && props.sort.direction === "asc"}
                onPress={() => props.onSortChange({ field: "createdAt", direction: "asc" })}
              >
                <NativeHeaderToolbar.Label>Created: oldest first</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      )}
    </>
  );
}

function ArchivedSortButton(props: {
  readonly field: ArchivedThreadSortField;
  readonly label: string;
  readonly sort: ArchivedThreadSortState;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const active = props.sort.field === props.field;
  return (
    <Pressable
      accessibilityLabel={`Sort by ${props.label}`}
      accessibilityRole="button"
      className={
        props.field === "archivedAt"
          ? "w-16 flex-row items-center justify-end gap-0.5 py-1"
          : "w-14 flex-row items-center justify-end gap-0.5 py-1"
      }
      onPress={() => props.onSortChange(nextArchivedThreadSortState(props.sort, props.field))}
    >
      <Text className="text-3xs font-t3-bold uppercase text-foreground-tertiary" numberOfLines={1}>
        {props.label}
      </Text>
      {active ? (
        <SymbolView
          name={props.sort.direction === "asc" ? "chevron.up" : "chevron.down"}
          size={9}
          tintColor={iconColor}
          type="monochrome"
        />
      ) : (
        <View className="w-[9px]" />
      )}
    </Pressable>
  );
}

function ProjectGroupHeader(props: {
  readonly environmentLabel: string | null;
  readonly expanded: boolean;
  readonly group: ArchivedThreadGroup;
  readonly isBusy: boolean;
  readonly isSearching: boolean;
  readonly onProjectAction: (action: "unarchive" | "delete") => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
  readonly onToggle: () => void;
  readonly sort: ArchivedThreadSortState;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const scopeLabel = props.isSearching ? "matching" : "all";
  const actions = useMemo<MenuAction[]>(
    () => [
      {
        id: "unarchive",
        title: `Unarchive ${scopeLabel}`,
        image: "arrow.uturn.backward",
      },
      {
        id: "delete",
        title: `Delete ${scopeLabel}`,
        image: "trash",
        attributes: { destructive: true },
      },
    ],
    [scopeLabel],
  );
  return (
    <View className="pt-3">
      <View className="min-h-11 flex-row items-center gap-2 px-1">
        <Pressable
          accessibilityLabel={`${props.expanded ? "Collapse" : "Expand"} ${props.group.project.title}`}
          accessibilityRole="button"
          className="min-w-0 flex-1 flex-row items-center gap-2.5 py-2"
          disabled={props.isSearching}
          onPress={props.onToggle}
        >
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={11}
            tintColor={iconColor}
            type="monochrome"
          />
          <ProjectFavicon
            environmentId={props.group.project.environmentId}
            projectTitle={props.group.project.title}
            size={18}
            workspaceRoot={props.group.project.workspaceRoot}
          />
          <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {props.group.project.title}
          </Text>
          <Text className="text-xs tabular-nums text-foreground-tertiary">
            {props.group.threads.length}
          </Text>
          {props.environmentLabel ? (
            <Text className="max-w-[32%] text-2xs text-foreground-tertiary" numberOfLines={1}>
              {props.environmentLabel}
            </Text>
          ) : null}
        </Pressable>
        {props.isBusy ? (
          <Pressable
            accessibilityLabel={`Project actions for ${props.group.project.title}`}
            accessibilityRole="button"
            className="size-9 items-center justify-center rounded-full active:bg-subtle"
            disabled
          >
            <ActivityIndicator color={iconColor} size="small" />
          </Pressable>
        ) : (
          <ControlPillMenu
            actions={actions}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "unarchive" || nativeEvent.event === "delete") {
                props.onProjectAction(nativeEvent.event);
              }
            }}
          >
            <Pressable
              accessibilityLabel={`Project actions for ${props.group.project.title}`}
              accessibilityRole="button"
              className="size-9 items-center justify-center rounded-full active:bg-subtle"
            >
              <SymbolView name="ellipsis" size={17} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </ControlPillMenu>
        )}
      </View>
      {props.expanded ? (
        <View className="flex-row items-center gap-2 px-4 pb-1">
          <Text className="min-w-0 flex-1 text-3xs font-t3-bold uppercase text-foreground-tertiary">
            Conversation
          </Text>
          <ArchivedSortButton
            field="archivedAt"
            label="Archived"
            onSortChange={props.onSortChange}
            sort={props.sort}
          />
          <ArchivedSortButton
            field="createdAt"
            label="Created"
            onSortChange={props.onSortChange}
            sort={props.sort}
          />
        </View>
      ) : null}
    </View>
  );
}

function ArchivedThreadRow(props: {
  readonly environmentLabel: string | null;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly isBusy: boolean;
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
  const archivedTimestamp = formatArchivedThreadRelativeTime(
    archivedThreadTimestampValue(props.thread, "archivedAt"),
  );
  const createdTimestamp = formatArchivedThreadRelativeTime(props.thread.createdAt);
  const subtitle = [props.environmentLabel, props.thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  const onDelete = props.isBusy ? () => undefined : props.onDelete;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      { id: "unarchive", title: "Unarchive", image: "arrow.uturn.backward" },
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
    [],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "unarchive") props.onUnarchive();
      if (nativeEvent.event === "delete") props.onDelete();
    },
    [props.onDelete, props.onUnarchive],
  );
  const rowContent = (
    <View
      className="min-h-14 flex-row items-center gap-2 bg-card px-4 py-2.5"
      style={{
        borderBottomColor: separatorColor,
        borderBottomWidth: props.isLast ? 0 : 1,
      }}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          {props.isBusy ? <ActivityIndicator color={iconColor} size="small" /> : null}
          <Text
            className="min-w-0 flex-1 text-sm font-t3-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {props.thread.title}
          </Text>
        </View>
        {subtitle.length > 0 ? (
          <Text className="font-mono text-2xs text-foreground-tertiary" numberOfLines={1}>
            {subtitle.join(" · ")}
          </Text>
        ) : null}
      </View>
      <Text className="w-16 text-right font-mono text-2xs tabular-nums text-foreground-tertiary">
        {archivedTimestamp ?? "—"}
      </Text>
      <Text className="w-14 text-right font-mono text-2xs tabular-nums text-foreground-tertiary">
        {createdTimestamp ?? "—"}
      </Text>
    </View>
  );
  return (
    <ThreadSwipeable
      backgroundColor={cardColor}
      // Round + clip the swipeable container so the group's corners stay
      // rounded while rows swipe; the row itself stays square inside.
      containerStyle={{
        borderTopLeftRadius: props.isFirst ? 20 : 0,
        borderTopRightRadius: props.isFirst ? 20 : 0,
        borderBottomLeftRadius: props.isLast ? 20 : 0,
        borderBottomRightRadius: props.isLast ? 20 : 0,
        overflow: "hidden",
      }}
      enabled={!props.isBusy}
      fullSwipeWidth={windowWidth - 32}
      onDelete={onDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={{
        accessibilityLabel: `Unarchive ${props.thread.title}`,
        icon: "arrow.uturn.backward",
        label: "Unarchive",
        onPress: props.isBusy ? () => undefined : props.onUnarchive,
      }}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={props.thread.title}
    >
      {() =>
        props.isBusy ? (
          rowContent
        ) : (
          <ControlPillMenu
            actions={menuActions}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent}
          </ControlPillMenu>
        )
      }
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
  readonly sort: ArchivedThreadSortState;
  readonly busyThreadKeys: ReadonlySet<string>;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectAction: (
    projectTitle: string,
    threads: ReadonlyArray<EnvironmentThreadShell>,
    scope: "all" | "matching",
    action: "unarchive" | "delete",
  ) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
  readonly onUnarchiveThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { onDeleteThread, onUnarchiveThread } = props;
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [listViewportHeight, setListViewportHeight] = useState(0);
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
  const isSearching = props.searchQuery.trim().length > 0;
  const listItems = useMemo<ReadonlyArray<ArchivedThreadListItem>>(() => {
    const items: ArchivedThreadListItem[] = [];
    for (const group of props.groups) {
      const environmentLabel = environmentLabelsById.get(group.project.environmentId) ?? null;
      const expanded = isSearching || expandedProjectKeys.has(group.key);
      items.push({
        kind: "project",
        key: `${group.key}:project`,
        environmentLabel,
        expanded,
        group,
        isSearching,
        isBusy: group.threads.some((thread) =>
          props.busyThreadKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
        ),
      });

      if (!expanded) continue;
      group.threads.forEach((thread, index) => {
        items.push({
          kind: "thread",
          key: scopedThreadKey(thread.environmentId, thread.id),
          environmentLabel,
          isFirst: index === 0,
          isLast: index === group.threads.length - 1,
          thread,
        });
      });
    }
    return items;
  }, [environmentLabelsById, expandedProjectKeys, isSearching, props.busyThreadKeys, props.groups]);
  const toggleProject = useCallback((projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  }, []);
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
          <ProjectGroupHeader
            environmentLabel={item.environmentLabel}
            expanded={item.expanded}
            group={item.group}
            isBusy={item.isBusy}
            isSearching={item.isSearching}
            onProjectAction={(action) =>
              props.onProjectAction(
                item.group.project.title,
                item.group.threads,
                item.isSearching ? "matching" : "all",
                action,
              )
            }
            onSortChange={props.onSortChange}
            onToggle={() => toggleProject(item.group.key)}
            sort={props.sort}
          />
        );
      }

      return (
        <ArchivedThreadRow
          environmentLabel={item.environmentLabel}
          isFirst={item.isFirst}
          isLast={item.isLast}
          isBusy={props.busyThreadKeys.has(
            scopedThreadKey(item.thread.environmentId, item.thread.id),
          )}
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
      props.busyThreadKeys,
      props.onProjectAction,
      props.onSortChange,
      props.sort,
      toggleProject,
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
        searchQuery={props.searchQuery}
        onEnvironmentChange={props.onEnvironmentChange}
        onRefresh={props.onRefresh}
        onSearchQueryChange={props.onSearchQueryChange}
        onSortChange={props.onSortChange}
        selectedEnvironmentId={props.selectedEnvironmentId}
        sort={props.sort}
      />

      <GestureDetector gesture={archiveScrollGesture}>
        {/* The detented iOS settings sheet and its keyboard-integrated search
            toolbar resize this viewport together. Reset the native render
            window when either the query or viewport changes so rows do not
            retain an off-screen window after those transitions. */}
        <FlatList
          key={`archive-results:${props.searchQuery}:${listViewportHeight}`}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: 32,
            paddingHorizontal: 16,
            paddingTop: 4,
          }}
          contentInsetAdjustmentBehavior="automatic"
          data={listItems}
          extraData={props.searchQuery}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmptyComponent}
          ListHeaderComponent={
            props.error ? <ArchiveError message={props.error} onRetry={props.onRefresh} /> : null
          }
          onLayout={(event) => {
            const nextHeight = Math.round(event.nativeEvent.layout.height);
            setListViewportHeight((currentHeight) =>
              currentHeight === nextHeight ? currentHeight : nextHeight,
            );
          }}
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
