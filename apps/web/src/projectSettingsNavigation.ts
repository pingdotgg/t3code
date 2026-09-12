import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { derivePhysicalProjectKey } from "./logicalProject";

export function projectSettingsSearch(
  projectKey: string,
  project?: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
) {
  return {
    project: projectKey,
    machine: project?.environmentId,
    checkout: project ? derivePhysicalProjectKey(project) : undefined,
  };
}
