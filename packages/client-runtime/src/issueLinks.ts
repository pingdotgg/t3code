import type { IssueRef } from "@t3tools/contracts";

import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

type LinkProject = Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

/** The host and scope a project's git-host tracker is bound to, the way the server resolves it. */
function projectIssueBinding(project: LinkProject): {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
} | null {
  const identity = project.repositoryIdentity;
  const scope = sourceControlClients.issueScope(identity);
  const kind = identity?.provider;
  if (!identity || kind === undefined || kind === "unknown" || scope === null) return null;
  return {
    tracker: kind,
    host: sourceControlClients.changeRequestHost(identity, kind),
    scope: scope.toLowerCase(),
  };
}

/**
 * The reference an issue link resolves to, and the project it is read through: the project whose
 * tracker binding is that host and scope, else any project on the same tracker and host lending
 * its credentials for a read-only view. The same rule as the server's `IssueService.resolveUrl`,
 * applied on the client so a lookalike hostname matches no project and stays an ordinary link.
 */
export function resolveIssueLinkTarget<Project extends LinkProject>(input: {
  readonly url: string;
  /** The projects of the environment the link is read in. */
  readonly projects: ReadonlyArray<Project>;
  readonly preferredProjectId?: string | undefined;
}): { readonly project: Project; readonly ref: IssueRef } | null {
  const parsed = sourceControlClients.parseIssueUrl(input.url);
  if (parsed === null) return null;
  const { definition, link } = parsed;
  const bound = input.projects.flatMap((project) => {
    const binding = projectIssueBinding(project);
    return binding === null || binding.tracker !== definition.kind || binding.host !== link.host
      ? []
      : [{ project, binding }];
  });
  const preferFirst = (candidates: typeof bound) =>
    candidates.find((candidate) => candidate.project.id === input.preferredProjectId) ??
    candidates[0];
  const own = preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scope));
  const lender = own ?? preferFirst(bound);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: lender.binding.tracker as IssueRef["tracker"],
      host: lender.binding.host,
      scope: own === undefined ? link.scope : lender.binding.scope,
      key: link.key,
    },
  };
}
