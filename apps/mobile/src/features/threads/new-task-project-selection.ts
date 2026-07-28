import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import type { HomeProjectScope } from "../home/homeThreadList";

export type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.projects.length === 1 ? (onlyScope.projects[0] ?? null) : null;
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  if (selectedProjectKey !== null) {
    return { kind: "preserve" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}
