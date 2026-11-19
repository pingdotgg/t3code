import type { IssueRef, IssueTrackerConnectionList } from "@t3tools/contracts";
import {
  JIRA_HOST,
  JIRA_KIND,
  parseJiraIssueUrl,
} from "@t3tools/issue-tracker-jira/shared/issueUrl";
import {
  LINEAR_HOST,
  LINEAR_KIND,
  parseLinearIssueUrl,
} from "@t3tools/issue-tracker-linear/shared/issueUrl";

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

const STANDALONE_TRACKERS = [
  { tracker: LINEAR_KIND, parse: parseLinearIssueUrl },
  { tracker: JIRA_KIND, parse: parseJiraIssueUrl },
];

function parseStandaloneIssueLink(url: string) {
  try {
    const parsed = new URL(url);
    for (const { tracker, parse } of STANDALONE_TRACKERS) {
      const link = parse(parsed);
      if (link !== null) return { tracker, link };
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether `url` is a standalone tracker's issue link, which only bindings can resolve. */
export function isStandaloneIssueLink(url: string): boolean {
  return parseStandaloneIssueLink(url) !== null;
}

/** A cheap pre-check, so text without such a link never asks for the bindings. */
export function mayContainStandaloneIssueLink(text: string): boolean {
  return text.includes(`${LINEAR_HOST}/`) || text.includes(`.${JIRA_HOST}/`);
}

/**
 * A standalone tracker link resolves through the project bound to its scope, else any bound to
 * the tracker, and only when it names the workspace the credential reaches: team keys repeat
 * across workspaces, so a link elsewhere stays an ordinary link.
 */
function resolveStandaloneIssueLink<Project extends LinkProject>(
  url: string,
  projects: ReadonlyArray<Project>,
  trackers: IssueTrackerConnectionList | undefined,
  preferredProjectId: string | undefined,
): { readonly project: Project; readonly ref: IssueRef } | null {
  const parsed = trackers === undefined ? null : parseStandaloneIssueLink(url);
  if (parsed === null || trackers === undefined) return null;
  const { tracker, link } = parsed;
  const workspace = trackers.trackers.find(
    (connection) => connection.tracker === tracker && connection.account !== null,
  )?.workspace;
  if (workspace?.toLowerCase() !== link.workspace.toLowerCase()) return null;
  const { bindings } = trackers;
  const onTracker = projects.flatMap((project) => {
    const binding = bindings[project.id];
    return binding?.tracker === tracker ? [{ project, binding }] : [];
  });
  const preferFirst = (candidates: typeof onTracker) =>
    candidates.find((candidate) => candidate.project.id === preferredProjectId) ?? candidates[0];
  const scope = link.scope.toLowerCase();
  const own = preferFirst(
    onTracker.filter((candidate) => candidate.binding.scope.toLowerCase() === scope),
  );
  const lender = own ?? preferFirst(onTracker);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: lender.binding.tracker,
      host: link.host,
      scope: own === undefined ? link.scope : lender.binding.scope,
      key: link.key,
    },
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
  /** The environment's standalone trackers and bindings; without them only git-host links resolve. */
  readonly trackers?: IssueTrackerConnectionList | undefined;
}): { readonly project: Project; readonly ref: IssueRef } | null {
  // A link names its server's port; a binding does only when its remote or web URL did.
  const authority = linkAuthority(input.url);
  const parsed = parseIssueLink(input.url, authority, input.projects);
  if (parsed === null)
    return resolveStandaloneIssueLink(
      input.url,
      input.projects,
      input.trackers,
      input.preferredProjectId,
    );
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
