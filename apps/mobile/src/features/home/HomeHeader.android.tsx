import { useActiveThreadSort } from "../threads/use-active-thread-sort";
import { ACTIVE_THREAD_SORT_OPTIONS } from "@t3tools/client-runtime/state/shared-settings";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { MaterialThreadListToolbar } from "./MaterialThreadListToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

/** Android thread-list controls. Filters stay local to this view; active
 * sorting follows the preference shared through the connected environments. */
export function HomeHeader(props: HomeHeaderProps) {
  const { order, setOrder, available } = useActiveThreadSort();
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null || order !== "manual";
  const menuActions = useMemo<MenuAction[]>(
    () => [
      ...(available
        ? [
            {
              id: "active-sort",
              title: "Sort active threads",
              subactions: ACTIVE_THREAD_SORT_OPTIONS.map((option) => ({
                id: `active-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(order === option.value),
              })),
            },
          ]
        : []),
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
                  state: checkedMenuState(props.selectedProjectKey === null),
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: checkedMenuState(props.selectedProjectKey === project.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [
      order,
      available,
      props.environments,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedProjectKey,
    ],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      const activeSort = ACTIVE_THREAD_SORT_OPTIONS.find(
        (option) => id === `active-sort:${option.value}`,
      );
      if (available && activeSort) {
        setOrder(activeSort.value);
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
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
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
    },
    [props, available, setOrder],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <MaterialThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenSettings={props.onOpenSettings}
        onOpenEnvironments={props.onOpenEnvironments}
      />
    </>
  );
}
