import { useActiveThreadSort } from "../threads/use-active-thread-sort";
import { ACTIVE_THREAD_SORT_OPTIONS } from "@t3tools/client-runtime/state/shared-settings";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

/** Keeps the native search toolbar and the older iOS toolbar on the same
 * filter and sort choices, including the server-backed active-thread order. */
export function HomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useUniwindTheme()["--color-icon"];
  const { order, setOrder, available } = useActiveThreadSort();
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null || order !== "manual";
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu({
    ...props,
    ...(available ? { activeThreadSort: { order, onChange: setOrder } } : {}),
  });

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={filterMenu.items}
        options={{
          // Static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          headerTintColor: iconColor,
          unstable_headerRightItems: () => [
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
          ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
            ? {
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

      {NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED ? null : (
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
            {available ? (
              <NativeHeaderToolbar.Menu title="Sort active threads">
                <NativeHeaderToolbar.Label>Sort active threads</NativeHeaderToolbar.Label>
                {ACTIVE_THREAD_SORT_OPTIONS.map((option) => (
                  <NativeHeaderToolbar.MenuAction
                    key={option.value}
                    isOn={order === option.value}
                    onPress={() => setOrder(option.value)}
                  >
                    <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}
          </NativeHeaderToolbar.Menu>
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
