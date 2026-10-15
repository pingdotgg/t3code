import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

export type PullRequestEnvironmentTarget = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly host?: string;
};

/**
 * Another connected environment holding the pull request's repository, for when the one it was
 * opened in is unreachable. Null while the original is connected or no other copy exists.
 */
export function pullRequestFallbackEnvironment(
  target: PullRequestEnvironmentTarget,
  projects: ReadonlyArray<EnvironmentProject>,
  connectedEnvironmentIds: ReadonlySet<string>,
) {
  if (connectedEnvironmentIds.has(target.environmentId)) return null;
  const own = projects.find(
    (project) => project.environmentId === target.environmentId && project.id === target.projectId,
  );
  const host = target.host ?? own?.repositoryIdentity?.canonicalKey.split("/")[0];
  if (!host) return null;
  const key = `${host}/${target.repository}`.toLowerCase();
  const copy = projects.find(
    (project) =>
      project.environmentId !== target.environmentId &&
      connectedEnvironmentIds.has(project.environmentId) &&
      project.repositoryIdentity?.canonicalKey.toLowerCase() === key,
  );
  return copy ? { environmentId: String(copy.environmentId), projectId: String(copy.id) } : null;
}
