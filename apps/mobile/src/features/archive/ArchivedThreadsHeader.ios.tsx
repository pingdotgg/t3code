import { useWindowDimensions } from "react-native";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import type { ArchivedThreadsHeaderProps } from "./ArchivedThreadsHeader.types";

export function ArchivedThreadsHeader(props: ArchivedThreadsHeaderProps) {
  const { width } = useWindowDimensions();
  const hasCustomFilter = props.selectedEnvironmentId !== null || props.sortOrder !== "newest";
  const usesCompactMailToolbar = width < 700 && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
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
                allowToolbarIntegration: true,
                // Pre-glass iOS keeps the default pull-down placement.
                ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
                  ? { placement: "integratedButton" as const }
                  : null),
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
          <NativeHeaderToolbar.Button
            accessibilityLabel="Refresh archived threads"
            icon="arrow.clockwise"
            onPress={props.onRefresh}
            separateBackground
          />
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
