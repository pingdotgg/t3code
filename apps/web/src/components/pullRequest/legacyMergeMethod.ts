import type { EnvironmentId, PullRequestMergeMethod } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "~/logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "~/sidebarProjectGrouping";
import type { Project } from "~/types";

/**
 * The per-project merge method older releases kept in client settings. Project settings stored
 * the override under the sidebar group's key, which a duplicate row borrows from its siblings,
 * so the project alone does not always name the same key.
 */
export function legacyProjectMergeMethod(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly grouping: ProjectGroupingSettings;
  readonly overrides: Readonly<Record<string, PullRequestMergeMethod>>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}): PullRequestMergeMethod | undefined {
  const project = input.projects.find(
    (candidate) =>
      candidate.environmentId === input.environmentId && candidate.id === input.projectId,
  );
  if (!project) return undefined;
  const projectKey =
    buildPhysicalToLogicalProjectKeyMap({
      projects: input.projects,
      settings: input.grouping,
      primaryEnvironmentId: input.primaryEnvironmentId,
    }).get(derivePhysicalProjectKey(project)) ??
    deriveLogicalProjectKeyFromSettings(project, input.grouping);
  return input.overrides[projectKey];
}
