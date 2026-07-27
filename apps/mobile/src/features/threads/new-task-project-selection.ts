import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import type { HomeProjectScope } from "../home/homeThreadList";

export function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.projects.length === 1 ? (onlyScope.projects[0] ?? null) : null;
}
