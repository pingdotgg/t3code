import { findProjectForChangeRequest } from "@t3tools/client-runtime/change-request-links";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

/**
 * Opens a change request in the app only under a project of the link's environment whose own
 * repository holds it, preferring the one the link came from; anything else is the browser's.
 */
export function nativePullRequestDestination(
  url: string,
  context: { environmentId: string; projectId: string } | null,
  projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">>,
) {
  const parsed = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (!parsed || !context) return null;
  const candidates = projects.filter((project) => project.environmentId === context.environmentId);
  const project = findProjectForChangeRequest(
    [
      ...candidates.filter((candidate) => candidate.id === context.projectId),
      ...candidates.filter((candidate) => candidate.id !== context.projectId),
    ],
    parsed,
  );
  if (project === undefined) return null;
  return {
    environmentId: context.environmentId,
    projectId: String(project.id),
    repository: parsed.repository,
    number: parsed.number,
    host: parsed.authority ?? parsed.host,
  };
}
