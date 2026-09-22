import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SettingsScreenContent } from "../settings/components/SettingsScreen";
import { SymbolView } from "../../components/AppSymbol";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
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
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useServerConfigs } from "../../state/entities";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import {
  archivedThreadActionKey,
  formatArchivedThreadRelativeTime,
  archivedThreadTimestampValue,
  nextArchivedThreadSortState,
  type ArchivedThreadGroup,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
} from "./archivedThreadList";

export interface ArchivedThreadsHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

type ArchivedThreadListItem =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly environmentMachine: EnvironmentMachineKind;
      readonly expanded: boolean;
      readonly group: ArchivedThreadGroup;
      readonly isSearching: boolean;
      readonly isReserved: boolean;
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

// A lowercase module-level wrapper avoids react(capitalized-calls), which otherwise makes React Compiler skip this screen.
function createNativeScrollGesture() {
  return Gesture.Native();
}

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
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const hasCustomFilter =
    props.selectedEnvironmentId !== null ||
    props.sort.field !== "archivedAt" ||
    props.sort.direction !== "desc";
  return (
    <ScreenHeader
      title="Archived threads"
      sidebar={false}
      onBack={() => navigation.goBack()}
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search archived threads",
        compactPlaceholder: "Search",
        mode: "inline",
        compactToolbar: width < 700,
      }}
      menus={[
        {
          title: "Archived thread options",
          icon: hasCustomFilter
            ? "line.3.horizontal.decrease.circle.fill"
            : "line.3.horizontal.decrease.circle",
          items: [
            {
              id: "environment",
              title: "Environment",
              items: [
                {
                  id: "environment:all",
                  title: "All environments",
                  selected: props.selectedEnvironmentId === null,
                  onPress: () => props.onEnvironmentChange(null),
                },
                ...props.environments.map((environment) => ({
                  id: `environment:${environment.environmentId}`,
                  title: environment.label,
                  selected: props.selectedEnvironmentId === environment.environmentId,
                  onPress: () => props.onEnvironmentChange(environment.environmentId),
                })),
              ],
            },
            {
              id: "sort",
              title: "Sort archived threads",
              items: [
                ...(["archivedAt", "createdAt"] as const).flatMap((field) =>
                  (["desc", "asc"] as const).map((direction) => ({
                    id: `sort:${field}:${direction}`,
                    title: `${field === "archivedAt" ? "Archived" : "Created"}: ${direction === "desc" ? "newest" : "oldest"} first`,
                    selected: props.sort.field === field && props.sort.direction === direction,
                    onPress: () => props.onSortChange({ field, direction }),
                  })),
                ),
              ],
            },
            ...(Platform.OS === "android"
              ? [
                  {
                    id: "refresh",
                    title: "Refresh archived threads",
                    onPress: props.onRefresh,
                  },
                ]
              : []),
          ],
        },
      ]}
    />
  );
}

function ArchivedSortButton(props: {
  readonly field: ArchivedThreadSortField;
  readonly label: string;
  readonly sort: ArchivedThreadSortState;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
}) {
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
          tintColorClassName={"accent-icon-subtle"}
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
  readonly environmentMachine: EnvironmentMachineKind;
  readonly expanded: boolean;
  readonly group: ArchivedThreadGroup;
  readonly isBusy: boolean;
  readonly isReserved: boolean;
  readonly isSearching: boolean;
  readonly onProjectAction: (action: "unarchive" | "delete") => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
  readonly onToggle: () => void;
  readonly sort: ArchivedThreadSortState;
}) {
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
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
          <ProjectFavicon
            environmentId={props.group.project.environmentId}
            faviconPath={props.group.project.faviconPath}
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
            <View className="max-w-[32%] flex-row items-center gap-1">
              <EnvironmentMachineSymbol
                kind={props.environmentMachine}
                size={10}
                tintColorClassName="accent-foreground-tertiary"
              />
              <Text className="shrink text-2xs text-foreground-tertiary" numberOfLines={1}>
                {props.environmentLabel}
              </Text>
            </View>
          ) : null}
        </Pressable>
        {props.isBusy ? (
          <Pressable
            accessibilityLabel={`Project actions for ${props.group.project.title}`}
            accessibilityRole="button"
            className="size-9 items-center justify-center rounded-full active:bg-subtle"
            disabled
          >
            <ActivityIndicator colorClassName={"accent-icon-subtle"} size="small" />
          </Pressable>
        ) : props.isReserved ? (
          <Pressable
            accessibilityLabel={`Project actions for ${props.group.project.title}`}
            accessibilityRole="button"
            className="size-9 items-center justify-center rounded-full opacity-50"
            disabled
          >
            <SymbolView
              name="ellipsis"
              size={17}
              tintColorClassName={"accent-icon-subtle"}
              type="monochrome"
            />
          </Pressable>
        ) : (
          <ControlPillMenu
            actions={actions}
            onPressAction={({ nativeEvent }: NativeActionEvent) => {
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
              <SymbolView
                name="ellipsis"
                size={17}
                tintColorClassName={"accent-icon-subtle"}
                type="monochrome"
              />
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
  readonly isReserved: boolean;
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
  const { onDelete, onUnarchive } = props;
  const archivedTimestamp = formatArchivedThreadRelativeTime(
    archivedThreadTimestampValue(props.thread, "archivedAt"),
  );
  const createdTimestamp = formatArchivedThreadRelativeTime(props.thread.createdAt);
  const subtitle = [props.environmentLabel, props.thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  const isBlocked = props.isReserved || props.isBusy;
  const swipeDeleteAction = isBlocked ? () => undefined : onDelete;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      { id: "unarchive", title: "Unarchive", image: "arrow.uturn.backward" },
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
    [],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "unarchive") onUnarchive();
      if (nativeEvent.event === "delete") onDelete();
    },
    [onDelete, onUnarchive],
  );
  const rowContent = (
    <View
      className={`min-h-14 flex-row items-center gap-2 bg-card px-4 py-2.5 ${props.isLast ? "" : "border-b border-separator"}`}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          {props.isBusy ? (
            <ActivityIndicator colorClassName={"accent-icon-subtle"} size="small" />
          ) : null}
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
      resetKey={JSON.stringify([props.thread.environmentId, props.thread.id])}
      threadKey={`${props.thread.environmentId}:${props.thread.id}`}
      // Round + clip the swipeable container so the group's corners stay
      // rounded while rows swipe; the row itself stays square inside.
      containerStyle={{
        borderTopLeftRadius: props.isFirst ? 20 : 0,
        borderTopRightRadius: props.isFirst ? 20 : 0,
        borderBottomLeftRadius: props.isLast ? 20 : 0,
        borderBottomRightRadius: props.isLast ? 20 : 0,
        overflow: "hidden",
      }}
      enabled={!isBlocked}
      fullSwipeWidth={windowWidth - 32}
      onDelete={swipeDeleteAction}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={{
        accessibilityLabel: `Unarchive ${props.thread.title}`,
        icon: "arrow.uturn.backward",
        label: "Unarchive",
        onPress: isBlocked ? () => undefined : onUnarchive,
      }}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={props.thread.title}
    >
      {() =>
        isBlocked ? (
          rowContent
        ) : (
          <ControlPillMenu
            actions={menuActions}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            <Pressable>{rowContent}</Pressable>
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
  readonly reservedThreadKeys: ReadonlySet<string>;
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
  const {
    busyThreadKeys,
    onDeleteThread,
    onProjectAction,
    onSortChange,
    onUnarchiveThread,
    reservedThreadKeys,
    sort,
  } = props;
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const archiveScrollGesture = useMemo(() => createNativeScrollGesture(), []);
  const environmentLabelsById = useMemo(
    () =>
      new Map(
        props.environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [props.environments],
  );
  const serverConfigs = useServerConfigs();
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
        environmentMachine: resolveEnvironmentMachineKind(
          serverConfigs.get(group.project.environmentId) ?? null,
        ),
        expanded,
        group,
        isSearching,
        isReserved: group.threads.some((thread) =>
          reservedThreadKeys.has(archivedThreadActionKey(thread)),
        ),
        isBusy: group.threads.some((thread) => busyThreadKeys.has(archivedThreadActionKey(thread))),
      });

      if (!expanded) continue;
      group.threads.forEach((thread, index) => {
        items.push({
          kind: "thread",
          key: archivedThreadActionKey(thread),
          environmentLabel,
          isFirst: index === 0,
          isLast: index === group.threads.length - 1,
          thread,
        });
      });
    }
    return items;
  }, [
    environmentLabelsById,
    expandedProjectKeys,
    isSearching,
    busyThreadKeys,
    props.groups,
    reservedThreadKeys,
    serverConfigs,
  ]);
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
            environmentMachine={item.environmentMachine}
            expanded={item.expanded}
            group={item.group}
            isBusy={item.isBusy}
            isReserved={item.isReserved}
            isSearching={item.isSearching}
            onProjectAction={(action) =>
              onProjectAction(
                item.group.project.title,
                item.group.threads,
                item.isSearching ? "matching" : "all",
                action,
              )
            }
            onSortChange={onSortChange}
            onToggle={() => toggleProject(item.group.key)}
            sort={sort}
          />
        );
      }

      return (
        <ArchivedThreadRow
          environmentLabel={item.environmentLabel}
          isFirst={item.isFirst}
          isLast={item.isLast}
          isBusy={busyThreadKeys.has(archivedThreadActionKey(item.thread))}
          isReserved={reservedThreadKeys.has(archivedThreadActionKey(item.thread))}
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
      busyThreadKeys,
      reservedThreadKeys,
      onProjectAction,
      onSortChange,
      sort,
      toggleProject,
    ],
  );
  const listEmptyComponent = useMemo(() => {
    if (isInitialLoad) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator colorClassName={"accent-icon"} />
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
  }, [isFiltered, isInitialLoad]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
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

      <SettingsScreenContent>
        <GestureDetector gesture={archiveScrollGesture}>
          <LegendList
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingBottom: 32,
              paddingHorizontal: 16,
              paddingTop: 4,
            }}
            contentInsetAdjustmentBehavior="automatic"
            data={listItems}
            extraData={props.searchQuery}
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
                tintColorClassName={String("accent-icon")}
              />
            }
            renderItem={renderListItem}
            showsVerticalScrollIndicator={false}
          />
        </GestureDetector>
      </SettingsScreenContent>
    </View>
  );
}
