import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { use, useCallback, useRef } from "react";
import { Platform } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../layout/use-native-mail-search-toolbar";
import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../../native/NativeWorkspaceColumns";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import { createSidebarHeaderItems } from "../threads/sidebar-native-header-items";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const primaryColumn = use(NativePrimaryColumnContext);
  const iPadSidebar = Platform.OS === "ios" && Platform.isPad && primaryColumn !== null;
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useUniwindTheme()["--color-icon"];
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu(props);

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={filterMenu.items}
        options={{
          // Static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          headerTintColor: iconColor,
          unstable_headerRightItems: () =>
            iPadSidebar
              ? createSidebarHeaderItems({
                  filterIcon: hasCustomListOptions
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle",
                  filterMenu,
                  onOpenSettings: props.onOpenSettings,
                })
              : [
                  withNativeGlassHeaderItem({
                    accessibilityLabel: "Open settings",
                    icon: { name: "ellipsis", type: "sfSymbol" } as const,
                    identifier: "home-settings",
                    label: "",
                    onPress: props.onOpenSettings,
                    type: "button",
                  }),
                ],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by NativeHeaderToolbar.
          ...(iPadSidebar
            ? {
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked" as const,
                  allowToolbarIntegration: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => props.onSearchQueryChange(""),
                  onChangeText: (event) => props.onSearchQueryChange(event.nativeEvent.text),
                },
                unstable_headerToolbarItems: () => [],
              }
            : usesNativeMailSearchToolbar
              ? {
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    onCancelButtonPress: () => props.onSearchQueryChange(""),
                  },
                  unstable_headerToolbarItems: () => [
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
                      showsSearchDismissButton: true,
                    }),
                  ],
                }
              : {
                  // Pre-Liquid-Glass iOS: standard pull-down search in the nav
                  // bar; create + sort live in the plain bottom toolbar below.
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    hideNavigationBar: false,
                    placeholder: "Search",
                    ...(NATIVE_WORKSPACE_COLUMNS_SUPPORTED
                      ? {
                          hideWhenScrolling: false,
                          placement: "integrated" as const,
                          allowToolbarIntegration: true,
                        }
                      : {}),
                    onCancelButtonPress: () => {
                      props.onSearchQueryChange("");
                    },
                    onChangeText: (event) => {
                      props.onSearchQueryChange(event.nativeEvent.text);
                    },
                  },
                }),
        }}
      />

      {iPadSidebar || usesNativeMailSearchToolbar ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
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

            {props.projects.length > 0 ? (
              <NativeHeaderToolbar.Menu title="Project">
                <NativeHeaderToolbar.Label>Project</NativeHeaderToolbar.Label>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <NativeHeaderToolbar.Label>All projects</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {props.projects.map((project) => (
                  <NativeHeaderToolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                  >
                    <NativeHeaderToolbar.Label>{project.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}
          </NativeHeaderToolbar.Menu>
          {NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? <NativeHeaderToolbar.SearchBarSlot /> : null}
          <NativeHeaderToolbar.Spacer flexible />
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
