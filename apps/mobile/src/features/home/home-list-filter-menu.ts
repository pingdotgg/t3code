import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { msg } from "gt-react-native";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function homeListFilterEnvironments(environments: ReadonlyArray<WorkspaceEnvironment>) {
  return Arr.sort(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.environmentLabel,
        connectionState: environment.connectionState,
      })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
  /** The machine(s) the project sits on, set while the list spans several. */
  readonly subtitle?: string;
}

/** A workspace from the device's Orbit profile; selecting one scopes the list to its projects. */
export interface HomeListFilterMenuWorkspace {
  readonly id: string;
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
  readonly workspaces?: ReadonlyArray<HomeListFilterMenuWorkspace>;
  readonly selectedWorkspaceId?: string | null;
  readonly onWorkspaceChange?: (workspaceId: string | null) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];
  const workspaces = props.workspaces ?? [];
  const onWorkspaceChange = props.onWorkspaceChange;

  if (workspaces.length > 0 && onWorkspaceChange) {
    items.push({
      type: "submenu",
      title: "Workspace",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every workspace",
          state: (props.selectedWorkspaceId ?? null) === null ? "on" : "off",
          onPress: () => onWorkspaceChange(null),
        },
        ...workspaces.map((workspace) => ({
          type: "action" as const,
          title: workspace.label,
          state: props.selectedWorkspaceId === workspace.id ? ("on" as const) : ("off" as const),
          onPress: () => onWorkspaceChange(workspace.id),
        })),
      ],
    });
  }

  items.push({
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
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          subtitle: project.subtitle,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
    readonly workspaces?: ReadonlyArray<HomeListFilterMenuWorkspace>;
    readonly selectedWorkspaceId?: string | null;
    readonly onWorkspaceChange?: (workspaceId: string | null) => void;
  },
  resolve: MessageResolver = m,
): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: resolve(msg("Environment", { $context: "filter menu heading" })),
      items: [
        {
          id: "environment:all",
          title: resolve(msg("All environments")),
          subtitle: resolve(msg("Show threads from every environment")),
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  const onWorkspaceChange = props.onWorkspaceChange;
  if (props.workspaces?.length && onWorkspaceChange) {
    items.unshift({
      id: "workspace",
      title: "Workspace",
      items: [
        {
          id: "workspace:all",
          title: "All projects",
          selected: props.selectedWorkspaceId == null,
          onPress: () => onWorkspaceChange(null),
        },
        ...props.workspaces.map((workspace) => ({
          id: `workspace:${workspace.id}`,
          title: workspace.label,
          selected: props.selectedWorkspaceId === workspace.id,
          onPress: () => onWorkspaceChange(workspace.id),
        })),
      ],
    });
  }

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: resolve(msg("Project", { $context: "filter menu heading" })),
      items: [
        {
          id: "project:all",
          title: resolve(msg("All projects")),
          subtitle: resolve(msg("Show threads from every project")),
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return items;
}
