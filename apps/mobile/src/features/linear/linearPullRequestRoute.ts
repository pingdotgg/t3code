import { resolveChangeRequestLinkTarget } from "@t3tools/client-runtime/change-request-links";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The PullRequest route for a pull request linked to a Linear issue when T3 holds that repository
 * (preferring the Linear environment's copy), else null so the link opens in the browser.
 */
export function linearPullRequestRoute(
  url: string,
  projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">>,
  options: {
    readonly environmentId: EnvironmentId | null;
    readonly configLoaded: (environmentId: EnvironmentId) => boolean;
  },
) {
  const target = resolveChangeRequestLinkTarget({
    url,
    projects,
    configLoaded: options.configLoaded,
    primaryEnvironmentId: options.environmentId,
    lendHostProject: false,
  });
  if (target === null) return null;
  return {
    environmentId: String(target.project.environmentId),
    projectId: String(target.project.id),
    repository: target.repository,
    number: target.number,
    ...(target.host === undefined ? {} : { host: target.host }),
  };
}
