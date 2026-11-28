import {
  IssueTrackerKind,
  issueTrackerBindingScopes,
  type IssueRef,
  type IssueTrackerConnectionList,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { builtInStandaloneIssueLinkDefinitions } from "@t3tools/source-control-definitions/standalone-issue-links";

import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

type LinkProject = Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

const issueBindingsByRepository = new WeakMap<
  RepositoryIdentity,
  ReturnType<typeof sourceControlClients.issueBindings>
>();

/** The hosts and scopes a project's git-host tracker is bound to, the way the server resolves them. */
function projectIssueBindings(project: LinkProject) {
  const identity = project.repositoryIdentity;
  if (identity == null) return [];
  const cached = issueBindingsByRepository.get(identity);
  if (cached !== undefined) return cached;
  const bindings = sourceControlClients
    .issueBindings(identity)
    .map((binding) => ({ ...binding, scope: binding.scope.toLowerCase() }));
  issueBindingsByRepository.set(identity, bindings);
  return bindings;
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
    const bindings = projectIssueBindings(project);
    if (!bindings.some((binding) => binding.host === hostname || binding.host === authority))
      continue;
    const known = sourceControlClients.parseIssueUrl(url, project.repositoryIdentity?.provider);
    if (known !== null) return known;
  }
  return null;
}

function parseStandaloneIssueLink(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const definition of builtInStandaloneIssueLinkDefinitions) {
    const link = definition.parseIssueUrl(parsed);
    if (link !== null) return { definition, link };
  }
  return null;
}

/** Whether `url` is a standalone tracker's issue link, which only bindings can resolve. */
export function isStandaloneIssueLink(url: string): boolean {
  return parseStandaloneIssueLink(url) !== null;
}

/** A cheap pre-check, so text without such a link never asks for the bindings. */
export function mayContainStandaloneIssueLink(text: string): boolean {
  return builtInStandaloneIssueLinkDefinitions.some((definition) =>
    definition.mayContainIssueUrl(text),
  );
}

/**
 * A standalone tracker link resolves through the project bound to its scope, else any bound to
 * the tracker, else the caller's unbound project. Every route needs an account that reaches the
 * link's workspace, because team keys repeat across workspaces.
 */
function resolveStandaloneIssueLink<Project extends LinkProject>(
  url: string,
  projects: ReadonlyArray<Project>,
  trackers: IssueTrackerConnectionList | undefined,
  preferredProjectId: string | undefined,
): { readonly project: Project; readonly ref: IssueRef } | null {
  const parsed = trackers === undefined ? null : parseStandaloneIssueLink(url);
  if (parsed === null || trackers === undefined) return null;
  const { link } = parsed;
  const { tracker } = parsed.definition;
  const accounts = new Set(
    [...trackers.trackers, ...(trackers.accounts ?? [])]
      .filter(
        (connection) =>
          connection.tracker === tracker &&
          connection.account !== null &&
          connection.workspace?.toLowerCase() === link.workspace.toLowerCase(),
      )
      .map((connection) => connection.accountId ?? null),
  );
  if (accounts.size === 0) return null;
  const bindings = { ...trackers.bindings, ...trackers.accountBindings };
  const onTracker = projects.flatMap((project) => {
    const binding = bindings[project.id];
    return binding?.tracker === tracker && accounts.has(binding.accountId ?? null)
      ? [{ project, binding }]
      : [];
  });
  const preferFirst = (candidates: typeof onTracker) =>
    candidates.find((candidate) => candidate.project.id === preferredProjectId) ?? candidates[0];
  const scope = link.scope.toLowerCase();
  const boundScope = (candidate: (typeof onTracker)[number]) =>
    issueTrackerBindingScopes(candidate.binding).find((key) => key.toLowerCase() === scope);
  const own = preferFirst(onTracker.filter((candidate) => boundScope(candidate) !== undefined));
  const lender = own ?? preferFirst(onTracker);
  // An unbound project reads with the tracker's first account, so that one must reach the workspace.
  const fallback = accounts.has(null)
    ? projects.find(
        (project) => project.id === preferredProjectId && bindings[project.id]?.tracker !== tracker,
      )
    : undefined;
  const project = lender?.project ?? fallback;
  if (project === undefined) return null;
  return {
    project,
    ref: {
      projectId: project.id,
      tracker,
      host: link.host,
      scope: (own && boundScope(own)) ?? link.scope,
      key: link.key,
    },
  };
}

/**
 * The reference an issue link resolves to and the project that reads it: the one bound to its
 * host and scope, else any lending its credentials read-only. These are the server's rules, run on
 * the client so a lookalike hostname matches no project and stays an ordinary link.
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
  const onHost = input.projects.flatMap((project) =>
    projectIssueBindings(project)
      .filter(
        (binding) =>
          binding.tracker === definition.kind &&
          (binding.host === link.host || binding.host === authority),
      )
      .map((binding) => ({ project, binding })),
  );
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
      tracker: IssueTrackerKind.make(lender.binding.tracker),
      host: lender.binding.host,
      scope: own === undefined ? link.scope : lender.binding.scope,
      key: link.key,
    },
  };
}
