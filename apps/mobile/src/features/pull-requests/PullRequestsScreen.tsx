import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListState,
  PullRequestProviderSummary,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { scorePullRequestMatch } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";

const MATCHED_ELSEWHERE_SCORE = 10;

const STATE_CHIPS: ReadonlyArray<{ value: PullRequestListState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

type ListItem =
  | { readonly kind: "group"; readonly key: string; readonly label: string }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly entry: PullRequestListEntry;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    };

export interface PullRequestListEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly supported: boolean;
}

export interface PullRequestListProject {
  readonly id: ProjectId;
  readonly title: string;
}

function checked(on: boolean) {
  return on ? ("on" as const) : undefined;
}

function PullRequestsHeader(props: {
  readonly environments: ReadonlyArray<PullRequestListEnvironment>;
  readonly projects: ReadonlyArray<PullRequestListProject>;
  readonly hosts: ReadonlyArray<PullRequestProviderSummary>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectId: ProjectId | undefined;
  readonly selectedHost: string | undefined;
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  readonly hasCustomFilter: boolean;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectId: ProjectId | undefined) => void;
  readonly onHostChange: (host: string | undefined) => void;
  readonly onInvolvementChange: (involvement: PullRequestInvolvement) => void;
  readonly onRefresh: () => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const searchIconColor = useThemeColor("--color-icon");
  const searchTextColor = useThemeColor("--color-foreground");
  const usesCompactMailToolbar =
    Platform.OS === "ios" && width < 700 && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;

  const filterMenu = {
    title: "Pull request options",
    items: [
      {
        type: "submenu" as const,
        title: "Involvement",
        items: [
          {
            type: "action" as const,
            title: "All",
            state: props.involvement === "all" ? ("on" as const) : ("off" as const),
            onPress: () => props.onInvolvementChange("all"),
          },
          {
            type: "action" as const,
            title: "Reviewing",
            state: props.involvement === "reviewing" ? ("on" as const) : ("off" as const),
            onPress: () => props.onInvolvementChange("reviewing"),
          },
          {
            type: "action" as const,
            title: "Authored",
            state: props.involvement === "authored" ? ("on" as const) : ("off" as const),
            onPress: () => props.onInvolvementChange("authored"),
          },
        ],
      },
      {
        type: "submenu" as const,
        title: "Environment",
        items: props.environments.map((environment) => ({
          type: "action" as const,
          title: environment.supported ? environment.label : `${environment.label} (unavailable)`,
          state:
            props.selectedEnvironmentId === environment.environmentId
              ? ("on" as const)
              : ("off" as const),
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      },
      {
        type: "submenu" as const,
        title: "Project",
        items: [
          {
            type: "action" as const,
            title: "All projects",
            state: props.selectedProjectId === undefined ? ("on" as const) : ("off" as const),
            onPress: () => props.onProjectChange(undefined),
          },
          ...props.projects.map((project) => ({
            type: "action" as const,
            title: project.title,
            state: props.selectedProjectId === project.id ? ("on" as const) : ("off" as const),
            onPress: () => props.onProjectChange(project.id),
          })),
        ],
      },
      ...(props.hosts.length > 1
        ? [
            {
              type: "submenu" as const,
              title: "Host",
              items: [
                {
                  type: "action" as const,
                  title: "Every host",
                  state: props.selectedHost === undefined ? ("on" as const) : ("off" as const),
                  onPress: () => props.onHostChange(undefined),
                },
                ...props.hosts.map((host) => ({
                  type: "action" as const,
                  title: host.host,
                  state: props.selectedHost === host.host ? ("on" as const) : ("off" as const),
                  onPress: () => props.onHostChange(host.host),
                })),
              ],
            },
          ]
        : []),
    ],
  };

  const androidFilterActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "involvement",
        title: "Involvement",
        subactions: [
          { id: "involvement:all", title: "All", state: checked(props.involvement === "all") },
          {
            id: "involvement:reviewing",
            title: "Reviewing",
            state: checked(props.involvement === "reviewing"),
          },
          {
            id: "involvement:authored",
            title: "Authored",
            state: checked(props.involvement === "authored"),
          },
        ],
      },
      {
        id: "environment",
        title: "Environment",
        subactions: props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          state: checked(props.selectedEnvironmentId === environment.environmentId),
        })),
      },
      {
        id: "project",
        title: "Project",
        subactions: [
          {
            id: "project:all",
            title: "All projects",
            state: checked(props.selectedProjectId === undefined),
          },
          ...props.projects.map((project) => ({
            id: `project:${project.id}`,
            title: project.title,
            state: checked(props.selectedProjectId === project.id),
          })),
        ],
      },
      ...(props.hosts.length > 1
        ? [
            {
              id: "host",
              title: "Host",
              subactions: [
                {
                  id: "host:all",
                  title: "Every host",
                  state: checked(props.selectedHost === undefined),
                },
                ...props.hosts.map((host) => ({
                  id: `host:${host.host}`,
                  title: host.host,
                  state: checked(props.selectedHost === host.host),
                })),
              ],
            },
          ]
        : []),
    ],
    [
      props.environments,
      props.hosts,
      props.involvement,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedHost,
      props.selectedProjectId,
    ],
  );

  const handleAndroidFilterAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = event.nativeEvent.event;
      if (action === "involvement:all") props.onInvolvementChange("all");
      else if (action === "involvement:reviewing") props.onInvolvementChange("reviewing");
      else if (action === "involvement:authored") props.onInvolvementChange("authored");
      else if (action === "project:all") props.onProjectChange(undefined);
      else if (action.startsWith("project:")) {
        props.onProjectChange(action.slice("project:".length) as ProjectId);
      } else if (action === "host:all") props.onHostChange(undefined);
      else if (action.startsWith("host:")) props.onHostChange(action.slice("host:".length));
      else if (action.startsWith("environment:")) {
        props.onEnvironmentChange(action.slice("environment:".length) as EnvironmentId);
      }
    },
    [props],
  );

  if (Platform.OS === "android") {
    return (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <View
          className="border-b border-header-border bg-header px-3 pb-2.5"
          style={{ paddingTop: Math.max(insets.top, 12) }}
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
                accessibilityLabel="Search pull requests"
                autoCapitalize="none"
                onChangeText={props.onSearchQueryChange}
                value={props.searchQuery}
                placeholder="Search pull requests"
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
                accessibilityLabel="Filter pull requests"
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={
                    props.hasCustomFilter
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

  return (
    <>
      <NativeStackScreenOptions
        options={{
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  composeButtonId: "pull-requests-refresh",
                  composeSystemImageName: "arrow.clockwise",
                  filterMenu,
                  filterButtonId: "pull-requests-filter",
                  filterSystemImageName: props.hasCustomFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onComposePress: props.onRefresh,
                  onSearchTextChange: props.onSearchQueryChange,
                  placeholder: "Search",
                  searchTextChangeId: "pull-requests-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                placeholder: "Search pull requests",
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
          <NativeHeaderToolbar.Button
            accessibilityLabel="Refresh pull requests"
            icon="arrow.clockwise"
            onPress={props.onRefresh}
            separateBackground
          />
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter pull requests"
            icon={
              props.hasCustomFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title="Pull request options"
          >
            <NativeHeaderToolbar.Menu title="Involvement">
              <NativeHeaderToolbar.MenuAction
                isOn={props.involvement === "all"}
                onPress={() => props.onInvolvementChange("all")}
              >
                <NativeHeaderToolbar.Label>All</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.involvement === "reviewing"}
                onPress={() => props.onInvolvementChange("reviewing")}
              >
                <NativeHeaderToolbar.Label>Reviewing</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.involvement === "authored"}
                onPress={() => props.onInvolvementChange("authored")}
              >
                <NativeHeaderToolbar.Label>Authored</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
            <NativeHeaderToolbar.Menu title="Environment">
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
            <NativeHeaderToolbar.Menu title="Project">
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedProjectId === undefined}
                onPress={() => props.onProjectChange(undefined)}
              >
                <NativeHeaderToolbar.Label>All projects</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.projects.map((project) => (
                <NativeHeaderToolbar.MenuAction
                  key={project.id}
                  isOn={props.selectedProjectId === project.id}
                  onPress={() => props.onProjectChange(project.id)}
                >
                  <NativeHeaderToolbar.Label>{project.title}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      )}
    </>
  );
}

function StateChips(props: {
  readonly state: PullRequestListState;
  readonly onChange: (state: PullRequestListState) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingBottom: 8, paddingTop: 4 }}
    >
      {STATE_CHIPS.map((chip) => {
        const selected = props.state === chip.value;
        return (
          <Pressable
            key={chip.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(chip.value)}
            className={cn("rounded-full px-3.5 py-1.5", selected ? "bg-primary" : "bg-subtle")}
          >
            <Text
              className={cn(
                "text-sm font-t3-bold",
                selected ? "text-primary-foreground" : "text-foreground",
              )}
            >
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function PullRequestsScreen(props: {
  readonly environments: ReadonlyArray<PullRequestListEnvironment>;
  readonly projects: ReadonlyArray<PullRequestListProject>;
  readonly hosts: ReadonlyArray<PullRequestProviderSummary>;
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly entries: ReadonlyArray<PullRequestListEntry>;
  }>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectId: ProjectId | undefined;
  readonly selectedHost: string | undefined;
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  readonly supported: boolean;
  readonly capabilityKnown: boolean;
  readonly hasProjects: boolean;
  readonly firstLoad: boolean;
  readonly refreshing: boolean;
  readonly loadingMore: boolean;
  readonly canLoadMore: boolean;
  readonly error: string | null;
  readonly querySettled: boolean;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectId: ProjectId | undefined) => void;
  readonly onHostChange: (host: string | undefined) => void;
  readonly onInvolvementChange: (involvement: PullRequestInvolvement) => void;
  readonly onStateChange: (state: PullRequestListState) => void;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
  readonly onSelect: (entry: PullRequestListEntry) => void;
  readonly onAddProject: () => void;
}) {
  const refreshTint = useThemeColor("--color-icon");
  const hasCustomFilter =
    props.involvement !== "all" ||
    props.selectedProjectId !== undefined ||
    props.selectedHost !== undefined;
  const showProvider = props.hosts.length > 1;
  const typedQuery = props.searchQuery.trim();
  const listItems = useMemo<ReadonlyArray<ListItem>>(() => {
    const items: ListItem[] = [];
    for (const group of props.groups) {
      items.push({ kind: "group", key: `group:${group.key}`, label: group.label });
      group.entries.forEach((entry, index) => {
        items.push({
          kind: "row",
          key: `${entry.host}:${entry.repository}#${entry.number}`,
          entry,
          isFirst: index === 0,
          isLast: index === group.entries.length - 1,
        });
      });
    }
    return items;
  }, [props.groups]);

  const listEmpty = useMemo((): ReactElement => {
    if (!props.capabilityKnown) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator color={refreshTint} />
          <Text className="mt-3 text-sm text-foreground-muted">Checking this environment…</Text>
        </View>
      );
    }
    if (!props.supported) {
      return (
        <EmptyState
          title="Pull requests need a newer environment"
          detail="This environment predates the pull-request workspace. Update T3 Code on that machine, then reconnect."
          actionLabel="Retry"
          onAction={props.onRefresh}
        />
      );
    }
    if (props.firstLoad) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator color={refreshTint} />
          <Text className="mt-3 text-sm text-foreground-muted">Loading pull requests…</Text>
        </View>
      );
    }
    if (props.error) {
      return (
        <EmptyState
          title="Could not load pull requests"
          detail={props.error}
          actionLabel="Retry"
          onAction={props.onRefresh}
        />
      );
    }
    if (!props.hasProjects) {
      return (
        <EmptyState
          title="No projects in this workspace"
          detail="Add a project, and the pull requests from its repository appear here."
          actionLabel="Add project"
          onAction={props.onAddProject}
        />
      );
    }
    if (typedQuery.length > 0 && !props.querySettled) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator color={refreshTint} />
          <Text className="mt-3 text-sm text-foreground-muted">
            Searching every host for “{typedQuery}”
          </Text>
        </View>
      );
    }
    if (typedQuery.length > 0) {
      return (
        <EmptyState
          title={`Nothing matches “${typedQuery.length > 48 ? `${typedQuery.slice(0, 48)}…` : typedQuery}”`}
          detail="The hosts were searched for it. Try fewer words, or search by number, author or branch."
          actionLabel="Clear search"
          onAction={() => props.onSearchQueryChange("")}
        />
      );
    }
    return (
      <EmptyState
        title="No pull requests"
        detail={
          hasCustomFilter
            ? "Nothing matches these filters. Try another involvement, project, or host."
            : "Open pull requests from this environment’s repositories will appear here."
        }
        actionLabel="Check again"
        onAction={props.onRefresh}
      />
    );
  }, [hasCustomFilter, props, refreshTint, typedQuery]);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.kind === "group") {
        return (
          <Text className="px-1 pb-2 pt-4 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted">
            {item.label}
          </Text>
        );
      }
      return (
        <PullRequestRow
          entry={item.entry}
          isFirst={item.isFirst}
          isLast={item.isLast}
          matchedElsewhere={
            typedQuery.length > 0 &&
            scorePullRequestMatch(item.entry, typedQuery) <= MATCHED_ELSEWHERE_SCORE
          }
          showHost={showProvider}
          onPress={props.onSelect}
        />
      );
    },
    [props.onSelect, showProvider, typedQuery],
  );

  const listFooter = useMemo((): ReactNode => {
    if (!props.canLoadMore && !props.loadingMore) return null;
    return (
      <View className="items-center py-4">
        {props.loadingMore ? (
          <ActivityIndicator color={refreshTint} />
        ) : (
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={props.onLoadMore}
          >
            <Text className="text-sm font-t3-bold text-foreground">Load more</Text>
          </Pressable>
        )}
      </View>
    );
  }, [props.canLoadMore, props.loadingMore, props.onLoadMore, refreshTint]);

  return (
    <View className="flex-1 bg-sheet">
      <PullRequestsHeader
        environments={props.environments}
        hasCustomFilter={hasCustomFilter}
        hosts={props.hosts}
        involvement={props.involvement}
        onEnvironmentChange={props.onEnvironmentChange}
        onHostChange={props.onHostChange}
        onInvolvementChange={props.onInvolvementChange}
        onProjectChange={props.onProjectChange}
        onRefresh={props.onRefresh}
        onSearchQueryChange={props.onSearchQueryChange}
        projects={props.projects}
        searchQuery={props.searchQuery}
        selectedEnvironmentId={props.selectedEnvironmentId}
        selectedHost={props.selectedHost}
        selectedProjectId={props.selectedProjectId}
        state={props.state}
      />
      <LegendList
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 }}
        contentInsetAdjustmentBehavior="automatic"
        data={listItems}
        estimatedItemSize={78}
        getItemType={(item) => item.kind}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.key}
        ListEmptyComponent={() => listEmpty}
        ListFooterComponent={() => listFooter}
        ListHeaderComponent={<StateChips state={props.state} onChange={props.onStateChange} />}
        refreshControl={
          <RefreshControl
            onRefresh={props.onRefresh}
            refreshing={props.refreshing && !props.firstLoad}
            tintColor={String(refreshTint)}
          />
        }
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
