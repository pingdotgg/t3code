import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import { Stack } from "expo-router";
import { useCallback, useRef } from "react";
import { Platform } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { useThemeColor } from "../../lib/useThemeColor";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
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
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useThemeColor("--color-icon");
  const hasCustomListOptions = hasCustomHomeListOptions(props);
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu(props);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerShadowVisible: false,
          headerLargeTitle: false,
          headerStyle: { backgroundColor: "transparent" },
          headerTintColor: iconColor,
          headerBackVisible: false,
          headerBackTitle: "",
          headerTitle: "Threads",
          headerTitleStyle: {
            fontSize: 18,
            fontWeight: "800",
          },
          unstable_navigationItemStyle: Platform.OS === "ios" ? "editor" : undefined,
          unstable_headerRightItems:
            Platform.OS === "ios"
              ? () => [
                  {
                    accessibilityLabel: "Open settings",
                    icon: { name: "ellipsis", type: "sfSymbol" },
                    identifier: "home-settings",
                    label: "",
                    onPress: props.onOpenSettings,
                    type: "button",
                  },
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
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            accessibilityLabel="Open settings"
            icon="gearshape"
            onPress={props.onOpenSettings}
            separateBackground
          />
        </Stack.Toolbar>
      )}

      {Platform.OS === "ios" ? null : (
        <Stack.Toolbar placement="bottom">
          <Stack.Toolbar.Menu
            accessibilityLabel="Filter and sort threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            <Stack.Toolbar.MenuAction onPress={props.onOpenSettings}>
              <Stack.Toolbar.Label>Settings</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>

            <Stack.Toolbar.Menu title="Environment">
              <Stack.Toolbar.Label>Environment</Stack.Toolbar.Label>
              <Stack.Toolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
                subtitle="Show threads from every environment"
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

            <Stack.Toolbar.Menu title="Sort projects">
              <Stack.Toolbar.Label>Sort projects</Stack.Toolbar.Label>
              {PROJECT_SORT_OPTIONS.map((option) => (
                <Stack.Toolbar.MenuAction
                  key={option.value}
                  isOn={props.projectSortOrder === option.value}
                  onPress={() => props.onProjectSortOrderChange(option.value)}
                >
                  <Stack.Toolbar.Label>{option.label}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>

            <Stack.Toolbar.Menu title="Sort threads">
              <Stack.Toolbar.Label>Sort threads</Stack.Toolbar.Label>
              {THREAD_SORT_OPTIONS.map((option) => (
                <Stack.Toolbar.MenuAction
                  key={option.value}
                  isOn={props.threadSortOrder === option.value}
                  onPress={() => props.onThreadSortOrderChange(option.value)}
                >
                  <Stack.Toolbar.Label>{option.label}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>

            <Stack.Toolbar.Menu title="Group projects">
              <Stack.Toolbar.Label>Group projects</Stack.Toolbar.Label>
              {PROJECT_GROUPING_OPTIONS.map((option) => (
                <Stack.Toolbar.MenuAction
                  key={option.value}
                  isOn={props.projectGroupingMode === option.value}
                  onPress={() => props.onProjectGroupingModeChange(option.value)}
                  subtitle={option.subtitle}
                >
                  <Stack.Toolbar.Label>{option.label}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Spacer width={8} sharesBackground={false} />
          <Stack.Toolbar.SearchBarSlot />
          <Stack.Toolbar.Spacer width={8} sharesBackground={false} />
          <Stack.Toolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </Stack.Toolbar>
      )}
    </>
  );
}
