import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";

import type { HomeProjectSortOrder } from "./homeThreadList";
import {
  PROJECT_GROUPING_OPTIONS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly showSubagentThreads: boolean;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  readonly onShowSubagentThreadsChange: (show: boolean) => void;
  readonly onOpenSettings?: () => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  if (props.onOpenSettings) {
    items.push({
      type: "action",
      title: "Settings",
      onPress: props.onOpenSettings,
    });
  }

  items.push(
    {
      type: "action",
      title: "Show nested subagents",
      subtitle: "Indent subagent threads beneath their parent",
      state: props.showSubagentThreads ? "on" : "off",
      onPress: () => props.onShowSubagentThreadsChange(!props.showSubagentThreads),
    },
    {
      type: "submenu",
      title: "Environment",
      items: [
        {
          type: "action",
          title: "All environments",
          subtitle: "Show threads from every environment",
          state: props.selectedEnvironmentId === null ? "on" : "off",
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
      type: "submenu",
      title: "Sort projects",
      items: PROJECT_SORT_OPTIONS.map((option) => ({
        type: "action",
        title: option.label,
        state: props.projectSortOrder === option.value ? "on" : "off",
        onPress: () => props.onProjectSortOrderChange(option.value),
      })),
    },
    {
      type: "submenu",
      title: "Sort threads",
      items: THREAD_SORT_OPTIONS.map((option) => ({
        type: "action",
        title: option.label,
        state: props.threadSortOrder === option.value ? "on" : "off",
        onPress: () => props.onThreadSortOrderChange(option.value),
      })),
    },
    {
      type: "submenu",
      title: "Group projects",
      items: PROJECT_GROUPING_OPTIONS.map((option) => ({
        type: "action",
        title: option.label,
        subtitle: option.subtitle,
        state: props.projectGroupingMode === option.value ? "on" : "off",
        onPress: () => props.onProjectGroupingModeChange(option.value),
      })),
    },
  );

  return {
    title: "Thread list options",
    items,
  };
}
