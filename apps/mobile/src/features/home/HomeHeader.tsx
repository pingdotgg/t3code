import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useMemo, useRef } from "react";
import { Platform, Pressable, Text as RNText, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { T3Wordmark } from "../../components/T3Wordmark";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import type { HomeProjectSortOrder } from "./homeThreadList";
import {
  buildHomeListFilterMenu,
  type HomeListFilterMenuEnvironment,
} from "./home-list-filter-menu";
import {
  hasCustomHomeListOptions,
  PROJECT_GROUPING_OPTIONS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly showSubagentThreads: boolean;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  readonly onShowSubagentThreadsChange: (show: boolean) => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  if (Platform.OS === "android") {
    return <AndroidHomeHeader {...props} />;
  }

  return <IosHomeHeader {...props} />;
}

type HomeHeaderProps = Parameters<typeof HomeHeader>[0];

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

function AndroidHomeHeader(props: HomeHeaderProps) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const hasCustomListOptions = hasCustomHomeListOptions(props) || props.showSubagentThreads;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: checkedMenuState(props.selectedEnvironmentId === null),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
          })),
        ],
      },
      {
        id: "project-sort",
        title: "Sort projects",
        subactions: PROJECT_SORT_OPTIONS.map((option) => ({
          id: `project-sort:${option.value}`,
          title: option.label,
          state: checkedMenuState(props.projectSortOrder === option.value),
        })),
      },
      {
        id: "thread-sort",
        title: "Sort threads",
        subactions: THREAD_SORT_OPTIONS.map((option) => ({
          id: `thread-sort:${option.value}`,
          title: option.label,
          state: checkedMenuState(props.threadSortOrder === option.value),
        })),
      },
      {
        id: "show-subagents",
        title: "Show nested subagents",
        subtitle: "Indent subagent threads beneath their parent",
        state: checkedMenuState(props.showSubagentThreads),
      },
      {
        id: "project-grouping",
        title: "Group projects",
        subactions: PROJECT_GROUPING_OPTIONS.map((option) => ({
          id: `project-grouping:${option.value}`,
          title: option.label,
          state: checkedMenuState(props.projectGroupingMode === option.value),
        })),
      },
    ],
    [
      props.environments,
      props.projectGroupingMode,
      props.projectSortOrder,
      props.selectedEnvironmentId,
      props.showSubagentThreads,
      props.threadSortOrder,
    ],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }

      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => id === `project-sort:${option.value}`,
      );
      if (projectSort) {
        props.onProjectSortOrderChange(projectSort.value);
        return;
      }

      const threadSort = THREAD_SORT_OPTIONS.find((option) => id === `thread-sort:${option.value}`);
      if (threadSort) {
        props.onThreadSortOrderChange(threadSort.value);
        return;
      }

      const grouping = PROJECT_GROUPING_OPTIONS.find(
        (option) => id === `project-grouping:${option.value}`,
      );
      if (grouping) {
        props.onProjectGroupingModeChange(grouping.value);
        return;
      }
      if (id === "show-subagents") {
        props.onShowSubagentThreadsChange(!props.showSubagentThreads);
      }
    },
    [props],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <View
        className="border-b border-header-border bg-header px-4 pb-3"
        style={{
          paddingTop: Math.max(insets.top, 12),
        }}
      >
        <View className="w-full max-w-[720px] self-center gap-3">
          <View className="flex-row items-center gap-2.5">
            <View className="flex-1 flex-row items-center gap-2">
              {/* Mirrors the desktop SidebarBrand: T3 mark + muted "Code". */}
              <T3Wordmark color={iconColor} height={15} />
              <RNText className="-ml-0.5 text-[21px] font-t3-medium tracking-[-0.5px] text-foreground-muted">
                Code
              </RNText>
              <View className="rounded-full bg-subtle px-2 py-0.75">
                <RNText className="text-[11px] font-t3-bold tracking-[1.1px] text-foreground-muted uppercase">
                  Alpha
                </RNText>
              </View>
            </View>

            <ControlPillMenu
              actions={menuActions}
              isAnchoredToRight
              onPressAction={handleMenuAction}
            >
              <Pressable
                accessibilityLabel="Filter and sort threads"
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={
                    hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={16}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
            {/* Built identically to the filter button so the two circles
                match exactly (ControlPill sizes via Tailwind classes and
                resolves to a different box). */}
            <Pressable
              accessibilityLabel="Open settings"
              accessibilityRole="button"
              onPress={props.onOpenSettings}
              className="size-11 items-center justify-center rounded-full bg-subtle"
            >
              <SymbolView name="gearshape" size={18} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </View>

          <View className="min-h-12 flex-row items-center gap-2.5 rounded-2xl border border-input-border bg-input px-3.5">
            <SymbolView name="magnifyingglass" size={17} tintColor={mutedColor} type="monochrome" />
            <TextInput
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search threads"
              placeholderTextColorClassName="accent-placeholder"
              className="flex-1 py-2.5 text-base font-sans text-foreground"
              value={props.searchQuery}
            />
            {props.searchQuery.length > 0 ? (
              <Pressable
                accessibilityLabel="Clear search"
                hitSlop={10}
                onPress={() => props.onSearchQueryChange("")}
              >
                <SymbolView
                  name="xmark.circle.fill"
                  size={17}
                  tintColor={mutedColor}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </>
  );
}

function IosHomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useThemeColor("--color-icon");
  const hasCustomListOptions = hasCustomHomeListOptions(props) || props.showSubagentThreads;
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu(props);

  return (
    <>
      <NativeStackScreenOptions
        options={{
          // Static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          headerTintColor: iconColor,
          unstable_headerRightItems:
            Platform.OS === "ios"
              ? () => [
                  withNativeGlassHeaderItem({
                    accessibilityLabel: "Open settings",
                    icon: { name: "ellipsis", type: "sfSymbol" } as const,
                    identifier: "home-settings",
                    label: "",
                    onPress: props.onOpenSettings,
                    type: "button",
                  }),
                ]
              : undefined,
          unstable_headerToolbarItems:
            Platform.OS === "ios"
              ? () => [
                  createNativeMailSearchToolbarItem({
                    composeButtonId: "home-new-task",
                    composeSystemImageName: "square.and.pencil",
                    filterMenu,
                    filterButtonId: "home-filter",
                    filterSystemImageName: hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease",
                    onComposePress: props.onStartNewTask,
                    onSearchTextChange: props.onSearchQueryChange,
                    placeholder: "Search",
                    searchTextChangeId: "home-search-text",
                  }),
                ]
              : undefined,
          headerSearchBarOptions:
            Platform.OS === "ios"
              ? undefined
              : {
                  ref: searchBarRef,
                  allowToolbarIntegration: true,
                  hideNavigationBar: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => {
                    props.onSearchQueryChange("");
                  },
                  onChangeText: (event) => {
                    props.onSearchQueryChange(event.nativeEvent.text);
                  },
                },
        }}
      />

      {Platform.OS === "ios" ? null : (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Open settings"
            icon="gearshape"
            onPress={props.onOpenSettings}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}

      {Platform.OS === "ios" ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter and sort threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            <NativeHeaderToolbar.MenuAction onPress={props.onOpenSettings}>
              <NativeHeaderToolbar.Label>Settings</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>

            <NativeHeaderToolbar.Menu title="Environment">
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
                subtitle="Show threads from every environment"
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

            <NativeHeaderToolbar.Menu title="Sort projects">
              <NativeHeaderToolbar.Label>Sort projects</NativeHeaderToolbar.Label>
              {PROJECT_SORT_OPTIONS.map((option) => (
                <NativeHeaderToolbar.MenuAction
                  key={option.value}
                  isOn={props.projectSortOrder === option.value}
                  onPress={() => props.onProjectSortOrderChange(option.value)}
                >
                  <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            <NativeHeaderToolbar.Menu title="Sort threads">
              <NativeHeaderToolbar.Label>Sort threads</NativeHeaderToolbar.Label>
              {THREAD_SORT_OPTIONS.map((option) => (
                <NativeHeaderToolbar.MenuAction
                  key={option.value}
                  isOn={props.threadSortOrder === option.value}
                  onPress={() => props.onThreadSortOrderChange(option.value)}
                >
                  <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            <NativeHeaderToolbar.Menu title="Group projects">
              <NativeHeaderToolbar.Label>Group projects</NativeHeaderToolbar.Label>
              {PROJECT_GROUPING_OPTIONS.map((option) => (
                <NativeHeaderToolbar.MenuAction
                  key={option.value}
                  isOn={props.projectGroupingMode === option.value}
                  onPress={() => props.onProjectGroupingModeChange(option.value)}
                  subtitle={option.subtitle}
                >
                  <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            <NativeHeaderToolbar.MenuAction
              isOn={props.showSubagentThreads}
              onPress={() => props.onShowSubagentThreadsChange(!props.showSubagentThreads)}
              subtitle="Indent subagent threads beneath their parent"
            >
              <NativeHeaderToolbar.Label>Show nested subagents</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          </NativeHeaderToolbar.Menu>
          <NativeHeaderToolbar.Spacer width={8} sharesBackground={false} />
          <NativeHeaderToolbar.SearchBarSlot />
          <NativeHeaderToolbar.Spacer width={8} sharesBackground={false} />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
    </>
  );
}
