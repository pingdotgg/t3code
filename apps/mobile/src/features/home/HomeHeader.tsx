import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { T3Wordmark } from "../../components/T3Wordmark";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import type { HomeProjectSortOrder } from "./homeThreadList";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";
import {
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { WorkspaceConnectionStatus } from "./WorkspaceConnectionStatus";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment & {
  readonly connectionState: EnvironmentConnectionPhase;
};

export function HomeHeader(props: {
  readonly catalogState: WorkspaceState;
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenSettings: () => void;
  readonly onReconnectEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const insets = useSafeAreaInsets();
  const searchInputRef = useRef<TextInput>(null);
  const [searchVisible, setSearchVisible] = useState(props.searchQuery.length > 0);
  const threadListV2Enabled = useThreadListV2Enabled();
  const hasCustomListOptions = threadListV2Enabled
    ? props.selectedEnvironmentId !== null || props.selectedProjectKey !== null
    : hasCustomHomeListOptions(props);

  const focusSearch = useCallback(() => {
    setSearchVisible(true);
    searchInputRef.current?.focus();
    return true;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  useEffect(() => {
    if (searchVisible) searchInputRef.current?.focus();
  }, [searchVisible]);

  const menuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? "on" : undefined,
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
      ...(props.projects.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  state: props.selectedProjectKey === null ? ("on" as const) : undefined,
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: props.selectedProjectKey === project.key ? ("on" as const) : undefined,
                })),
              ],
            },
          ] satisfies MenuAction[])),
      ...(threadListV2Enabled
        ? []
        : ([
            {
              id: "project-sort",
              title: "Sort projects",
              subactions: PROJECT_SORT_OPTIONS.map((option) => ({
                id: `project-sort:${option.value}`,
                title: option.label,
                state: props.projectSortOrder === option.value ? ("on" as const) : undefined,
              })),
            },
            {
              id: "thread-sort",
              title: "Sort threads",
              subactions: THREAD_SORT_OPTIONS.map((option) => ({
                id: `thread-sort:${option.value}`,
                title: option.label,
                state: props.threadSortOrder === option.value ? ("on" as const) : undefined,
              })),
            },
          ] satisfies MenuAction[])),
      { id: "settings", title: "Settings", image: "gearshape" },
    ],
    [
      props.environments,
      props.projectSortOrder,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedProjectKey,
      props.threadSortOrder,
      threadListV2Enabled,
    ],
  );

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const id = nativeEvent.event;
      if (id === "settings") {
        props.onOpenSettings();
        return;
      }
      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }
      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) props.onEnvironmentChange(environment.environmentId);
        return;
      }
      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }
      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
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
      if (threadSort) props.onThreadSortOrderChange(threadSort.value);
    },
    [props],
  );

  const troubledEnvironment =
    (props.selectedEnvironmentId === null
      ? undefined
      : props.environments.find(
          (environment) =>
            environment.environmentId === props.selectedEnvironmentId &&
            environment.connectionState !== "connected",
        )) ??
    props.environments.find(
      (environment) =>
        environment.connectionState === "connecting" ||
        environment.connectionState === "reconnecting",
    ) ??
    props.environments.find((environment) => environment.connectionState !== "connected") ??
    props.environments[0];
  const selectedEnvironment =
    props.selectedEnvironmentId === null
      ? null
      : (props.environments.find(
          (environment) => environment.environmentId === props.selectedEnvironmentId,
        ) ?? null);
  const selectedProjectLabel =
    props.projects.find((project) => project.key === props.selectedProjectKey)?.label ??
    "All projects";

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <View
        style={{
          backgroundColor: "#000",
          borderBottomColor: "rgba(255,255,255,0.06)",
          borderBottomWidth: 1,
          paddingTop: insets.top,
        }}
      >
        <View className="h-14 flex-row items-center px-4">
          <View className="min-w-0 flex-1">
            <WorkspaceConnectionStatus
              state={props.catalogState}
              environmentLabel={troubledEnvironment?.label}
              environmentConnectionState={troubledEnvironment?.connectionState}
              onPress={props.onOpenSettings}
              onReconnect={
                troubledEnvironment
                  ? () => props.onReconnectEnvironment(troubledEnvironment.environmentId)
                  : undefined
              }
              variant="header"
              fallback={
                <View
                  accessibilityLabel="T3 Code, Threads"
                  accessibilityRole="header"
                  className="flex-row items-center gap-2"
                >
                  <T3Wordmark color="#f5f5f5" height={16} />
                  <Text className="text-[21px] font-t3-medium tracking-[-0.5px] text-[#8e8e93]">
                    Code
                  </Text>
                </View>
              }
            />
          </View>
          <Pressable
            accessibilityLabel={searchVisible ? "Close thread search" : "Search threads"}
            accessibilityRole="button"
            className="size-12 items-center justify-center"
            hitSlop={4}
            onPress={() => {
              if (searchVisible) {
                props.onSearchQueryChange("");
                setSearchVisible(false);
              } else {
                setSearchVisible(true);
              }
            }}
          >
            <SymbolView
              name={searchVisible ? "xmark" : "magnifyingglass"}
              size={20}
              tintColor="#b9bbc2"
              type="monochrome"
            />
          </Pressable>
          <ControlPillMenu actions={menuActions} isAnchoredToRight onPressAction={handleMenuAction}>
            <Pressable
              accessibilityLabel="Filter threads and open settings"
              accessibilityRole="button"
              className="size-12 items-center justify-center"
              hitSlop={4}
            >
              <SymbolView
                name={
                  hasCustomListOptions
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle"
                }
                size={20}
                tintColor="#b9bbc2"
                type="monochrome"
              />
            </Pressable>
          </ControlPillMenu>
        </View>

        <View className="h-11 flex-row items-center px-4">
          {searchVisible ? (
            <>
              <SymbolView name="magnifyingglass" size={16} tintColor="#71717a" type="monochrome" />
              <TextInput
                ref={searchInputRef}
                accessibilityLabel="Search threads"
                autoCapitalize="none"
                autoCorrect={false}
                className="ml-2 flex-1 py-0 text-base font-sans text-white"
                onChangeText={props.onSearchQueryChange}
                placeholder="Search threads"
                placeholderTextColor="#52525b"
                returnKeyType="search"
                value={props.searchQuery}
              />
            </>
          ) : (
            <View className="flex-1">
              <ControlPillMenu actions={menuActions} onPressAction={handleMenuAction}>
                <Pressable
                  accessibilityLabel={`Project filter, ${selectedProjectLabel}`}
                  accessibilityRole="button"
                  className="h-11 w-full flex-row items-center"
                >
                  <SymbolView name="folder" size={16} tintColor="#71717a" type="monochrome" />
                  <Text
                    className="ml-2 max-w-[70%] text-sm font-t3-medium text-[#8e8e93]"
                    numberOfLines={1}
                  >
                    {selectedProjectLabel}
                  </Text>
                  <SymbolView name="chevron.down" size={10} tintColor="#636366" type="monochrome" />
                  {selectedEnvironment ? (
                    <Text className="ml-2 text-xs text-[#71717a]" numberOfLines={1}>
                      {selectedEnvironment.label}
                    </Text>
                  ) : null}
                </Pressable>
              </ControlPillMenu>
            </View>
          )}
        </View>
      </View>
    </>
  );
}
