import type { EnvironmentId } from "@t3tools/contracts";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
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
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly labels?: {
    readonly environment: string;
    readonly allEnvironments: string;
    readonly showThreadsFromEveryEnvironment: string;
    readonly project: string;
    readonly allProjects: string;
    readonly showThreadsFromEveryProject: string;
    readonly threadListOptions: string;
  };
}): HomeListFilterMenu {
  const labels = props.labels ?? {
    environment: "Environment",
    allEnvironments: "All environments",
    showThreadsFromEveryEnvironment: "Show threads from every environment",
    project: "Project",
    allProjects: "All projects",
    showThreadsFromEveryProject: "Show threads from every project",
    threadListOptions: "Thread list options",
  };
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  items.push({
    type: "submenu",
    title: labels.environment,
    items: [
      {
        type: "action",
        title: labels.allEnvironments,
        subtitle: labels.showThreadsFromEveryEnvironment,
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
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: labels.project,
      items: [
        {
          type: "action",
          title: labels.allProjects,
          subtitle: labels.showThreadsFromEveryProject,
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: labels.threadListOptions,
    items,
  };
}
