import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { RepositoryIdentity } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

export type PullRequestEnvironmentTarget = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly host?: string;
};

function repositoriesOf(project: EnvironmentProject): ReadonlyArray<RepositoryIdentity> {
  return project.repositoryIdentity != null
    ? [project.repositoryIdentity]
    : (project.workspaceRepositories ?? []);
}

export function pullRequestFallbackEnvironment(
  target: PullRequestEnvironmentTarget,
  projects: ReadonlyArray<EnvironmentProject>,
  environments: ReadonlyArray<
    Pick<EnvironmentConnectionSummary, "environmentId" | "connectionState" | "isEnabled">
  >,
) {
  const requested = environments.find(
    (environment) => environment.environmentId === target.environmentId,
  );
  // Pending connections retain the requested target until an explicit failure, even before
  // its project hydrates. Available includes the period before connection startup.
  if (
    requested?.isEnabled &&
    (requested.connectionState === "connected" ||
      requested.connectionState === "available" ||
      requested.connectionState === "connecting" ||
      requested.connectionState === "reconnecting")
  )
    return null;
  const connectedEnvironmentIds = new Set<string>(
    environments
      .filter((environment) => environment.isEnabled && environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const own = projects.find(
    (project) => project.environmentId === target.environmentId && project.id === target.projectId,
  );
  const repository = target.repository.trim().toLowerCase();
  const matchesRepository = (identity: RepositoryIdentity) =>
    sourceControlClients.repositorySelector(identity)?.toLowerCase() === repository ||
    sourceControlClients
      .canonicalRepositoryKey(identity.canonicalKey.toLowerCase())
      .split("/")
      .slice(1)
      .join("/") === repository;
  const hostOf = (identity: RepositoryIdentity) =>
    sourceControlClients.canonicalRepositoryKey(identity.canonicalKey.toLowerCase()).split("/")[0];
  const hosts = new Set(
    own === undefined ? [] : repositoriesOf(own).filter(matchesRepository).map(hostOf),
  );
  const host = target.host?.toLowerCase() ?? (hosts.size === 1 ? [...hosts][0] : undefined);
  if (!host) return null;
  const copy = projects.find(
    (project) =>
      project.environmentId !== target.environmentId &&
      connectedEnvironmentIds.has(project.environmentId) &&
      repositoriesOf(project).some(
        (identity) => matchesRepository(identity) && hostOf(identity) === host,
      ),
  );
  return copy ? { environmentId: String(copy.environmentId), projectId: String(copy.id) } : null;
}
