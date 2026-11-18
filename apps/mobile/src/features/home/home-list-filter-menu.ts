import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { msg } from "gt-react-native";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import type { HomeProjectScope } from "./homeThreadList";

const projectLabelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

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
  readonly pinned: boolean;
  readonly project: HomeProjectScope["representative"];
  readonly members: HomeProjectScope["projects"];
}

export function filterProjectOptions(
  projects: ReadonlyArray<HomeListFilterMenuProject>,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return projects
    .filter(
      (project) =>
        project.label.toLocaleLowerCase().includes(search) ||
        project.members.some((member) =>
          `${member.title} ${member.workspaceRoot}`.toLocaleLowerCase().includes(search),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        projectLabelCollator.compare(a.label, b.label) ||
        a.key.localeCompare(b.key),
    );
}

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onOpenProjectPicker: () => void;
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

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: resolve(msg("Project", { $context: "filter menu heading" })),
      icon: "folder",
      subtitle:
        props.projects.find((project) => project.key === props.selectedProjectKey)?.label ??
        resolve(msg("All projects")),
      onPress: props.onOpenProjectPicker,
    });
  }

  return items;
}
