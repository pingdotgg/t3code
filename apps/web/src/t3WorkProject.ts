import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ProjectId, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

export const T3_WORK_BACKING_PROJECT_ID = ProjectId.make("project:t3-work");
export const T3_WORK_BACKING_PROJECT_TITLE = "T3 Work";

export function t3WorkDirectoryForEnvironment(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  environmentId: EnvironmentId | null,
): string | null {
  if (environmentId === null) return null;
  return serverConfigs.get(environmentId)?.t3WorkDirectory ?? null;
}

export function isT3WorkBackingProject(
  project: EnvironmentProject,
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): boolean {
  const workDirectory = t3WorkDirectoryForEnvironment(serverConfigs, project.environmentId);
  return workDirectory !== null && project.workspaceRoot === workDirectory;
}
