import type { MenuAction } from "@react-native-menu/menu";

import type { HomeListFilterMenuProject } from "./home-list-filter-menu";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function buildAndroidProjectFilterActions(
  projects: ReadonlyArray<HomeListFilterMenuProject>,
  selectedProjectKey: string | null,
): MenuAction[] {
  return [
    {
      id: "project:all",
      title: "All projects",
      state: checkedMenuState(selectedProjectKey === null),
    },
    ...projects.map((project) => ({
      id: `project:${project.key}`,
      title: project.label,
      state: checkedMenuState(selectedProjectKey === project.key),
    })),
  ];
}

export function resolveAndroidProjectFilterProject(
  actionId: string | undefined,
  projects: ReadonlyArray<HomeListFilterMenuProject>,
): HomeListFilterMenuProject | null {
  if (!actionId?.startsWith("project:") || actionId === "project:all") return null;
  const projectKey = actionId.slice("project:".length);
  return projects.find((project) => project.key === projectKey) ?? null;
}
