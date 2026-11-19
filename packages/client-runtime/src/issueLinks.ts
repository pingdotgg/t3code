import type { IssueRef, IssueTrackerConnectionList } from "@t3tools/contracts";
import {
  LINEAR_TRACKER,
  parseLinearIssueUrl,
} from "@t3tools/issue-tracker-linear/shared/issue-url";

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

function linkAuthority(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A host whose hostname does not name it, such as GitHub Enterprise Server, is vouched for by a project on it. */
function parseIssueLink(
  url: string,
  authority: string | null,
  projects: ReadonlyArray<LinkProject>,
) {
  const parsed = sourceControlClients.parseIssueUrl(url);
  if (parsed !== null || authority === null) return parsed;
  const hostname = new URL(url).hostname.toLowerCase();
  for (const project of projects) {
    const binding = projectIssueBinding(project);
    if (binding === null || (binding.host !== hostname && binding.host !== authority)) continue;
    const known = sourceControlClients.parseIssueUrl(url, project.repositoryIdentity?.provider);
    if (known !== null) return known;
  }
  return null;
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
  /** The environment's standalone tracker bindings; without them a Linear link stays plain. */
  readonly trackerBindings?: IssueTrackerConnectionList["bindings"] | undefined;
}): { readonly project: Project; readonly ref: IssueRef } | null {
  // A link names its server's port; a binding does only when its remote or web URL did.
  const authority = linkAuthority(input.url);
  const parsed = parseIssueLink(input.url, authority, input.projects);
  if (parsed === null) return resolveLinearIssueLink(input);
  const { definition, link } = parsed;
  const onHost = input.projects.flatMap((project) => {
    const binding = projectIssueBinding(project);
    return binding === null ||
      binding.tracker !== definition.kind ||
      (binding.host !== link.host && binding.host !== authority)
      ? []
      : [{ project, binding }];
  });
  const onAuthority = onHost.filter((candidate) => candidate.binding.host === authority);
  const bound = onAuthority.length > 0 ? onAuthority : onHost;
  const preferFirst = (candidates: typeof bound) =>
    candidates.find((candidate) => candidate.project.id === input.preferredProjectId) ??
    candidates[0];
  const own =
    preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scope)) ??
    preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scopeAlias));
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

/** A Linear link, read through the project bound to its team, else any project bound to Linear. */
function resolveLinearIssueLink<Project extends LinkProject>(input: {
  readonly url: string;
  readonly projects: ReadonlyArray<Project>;
  readonly preferredProjectId?: string | undefined;
  readonly trackerBindings?: IssueTrackerConnectionList["bindings"] | undefined;
}): { readonly project: Project; readonly ref: IssueRef } | null {
  const bindings = input.trackerBindings;
  if (bindings === undefined || !URL.canParse(input.url)) return null;
  const link = parseLinearIssueUrl(new URL(input.url));
  if (link === null) return null;
  const bound = input.projects.flatMap((project) => {
    const binding = bindings[project.id];
    return binding?.tracker === LINEAR_TRACKER ? [{ project, scope: binding.scope }] : [];
  });
  const preferFirst = (candidates: typeof bound) =>
    candidates.find((candidate) => candidate.project.id === input.preferredProjectId) ??
    candidates[0];
  const own = preferFirst(
    bound.filter((candidate) => candidate.scope.toLowerCase() === link.scope.toLowerCase()),
  );
  const lender = own ?? preferFirst(bound);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: LINEAR_TRACKER,
      host: link.host,
      scope: own === undefined ? link.scope : lender.scope,
      key: link.key,
    },
  };
}

/** Whether a link names a Linear issue, so tracker bindings could open it. */
export function isLinearIssueLink(url: string): boolean {
  return URL.canParse(url) && parseLinearIssueUrl(new URL(url)) !== null;
}

/**
 * Whether a Linear link names another workspace than the issue it opened. Team keys repeat across
 * workspaces, so the connected one can hold an issue under the same key; only the issue's own
 * URL says which workspace it is in, as in the server's `IssueService.resolveUrl`. Any link
 * that is not a Linear issue link is never another workspace's.
 */
export function linksAnotherLinearWorkspace(linkUrl: string, issueUrl: string): boolean {
  if (!URL.canParse(linkUrl)) return false;
  const link = parseLinearIssueUrl(new URL(linkUrl));
  if (link === null) return false;
  const issue = URL.canParse(issueUrl) ? parseLinearIssueUrl(new URL(issueUrl)) : null;
  return issue?.workspace !== link.workspace;
}
