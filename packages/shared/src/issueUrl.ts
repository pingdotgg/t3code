/**
 * An issue named the way a thread link names one: which tracker, the host it is served from, the
 * scope the tracker addresses it by, and the issue's native key within that scope.
 *
 * `host` and `scope` are written the way `resolveGitHostBinding` writes a project's binding —
 * lower case, the full repository path below the host — because links are matched against those.
 */
export interface IssueLink {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
  readonly workspace?: string;
}

export function azureDevOpsIssueScope(organization: string, project: string): string | null {
  try {
    const parts = [organization, project].map(decodeURIComponent);
    return parts.every(
      (part) => part.trim().length > 0 && !part.includes("/") && !part.includes("\\"),
    )
      ? parts.join("/")
      : null;
  } catch {
    return null;
  }
}

/** The host itself, one of its subdomains, or an install named after the provider. */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.split(".").includes(label);
}

/**
 * The tracker, scope and key behind an issue URL on a host this can read, or null for anything
 * else — a pull request, a repository root, a host this cannot tell apart from an ordinary link.
 * Like `parseChangeRequestUrl`, nothing here guesses: each host is recognised by the path shape it
 * alone uses, guarded by a hostname it could plausibly be served from. GitLab's `/-/` marker is
 * trusted on any hostname; `/issues/` is generic enough that it is only believed from a GitHub-ish
 * or Forgejo-ish host, since Forgejo and Gitea write it on any domain.
 *
 */
export function parseIssueUrl(
  targetUrl: string,
  configuredHost?: { readonly tracker: string; readonly host: string },
): IssueLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  const configuredTracker =
    configuredHost?.host.trim().toLowerCase() === host ? configuredHost.tracker : undefined;

  if (hostname === "linear.app") {
    if (url.protocol !== "https:" || url.port !== "") return null;
    const match = /^\/([^/]+)\/issue\/(([A-Za-z][A-Za-z0-9]*)-[1-9]\d*)(?:\/[^/]+)?\/?$/u.exec(
      url.pathname,
    );
    const workspace = match?.[1];
    const key = match?.[2];
    const scope = match?.[3];
    return workspace && key && scope
      ? {
          tracker: "linear",
          host,
          scope: `${workspace}/${scope}`.toLowerCase(),
          key: key.toUpperCase(),
          workspace: workspace.toLowerCase(),
        }
      : null;
  }
  if (hostname.endsWith(".atlassian.net")) {
    if (url.protocol !== "https:" || url.port !== "") return null;
    const match = /^\/browse\/(([A-Za-z][A-Za-z0-9_]*)-[1-9]\d*)\/?$/u.exec(url.pathname);
    const key = match?.[1];
    const scope = match?.[2];
    return key && scope
      ? { tracker: "jira", host, scope: scope.toLowerCase(), key: key.toUpperCase() }
      : null;
  }

  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/issues/{n}
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim("gitlab", host, gitlab);
  // Azure DevOps work items: /{org}/{project}/_workitems/edit/{n}. The scope is the repository
  // path the project binding writes, which a work item URL does not carry, so the organisation
  // and project stand in for it; the service matches by host and prefix.
  if (isHostOf(hostname, "dev.azure.com") || hostname.endsWith(".visualstudio.com")) {
    const legacy = hostname.endsWith(".visualstudio.com");
    const match = legacy
      ? /^\/(?:DefaultCollection\/)?([^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/iu.exec(url.pathname)
      : /^\/([^/]+\/[^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/u.exec(url.pathname);
    const [organization, project] = legacy
      ? [hostname.slice(0, -".visualstudio.com".length), match?.[1]]
      : (match?.[1]?.split("/") ?? []);
    const scope = organization && project ? azureDevOpsIssueScope(organization, project) : null;
    const issue = claim("azure-devops", host, match);
    return issue && scope ? { ...issue, scope: scope.toLowerCase() } : null;
  }
  // GitHub, and any Enterprise install: /{owner}/{repo}/issues/{n}
  const twoSegments = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (
    twoSegments &&
    (configuredTracker === "github" ||
      (configuredTracker === undefined && isHostOf(hostname, "github.com", "github")))
  ) {
    return claim("github", host, twoSegments);
  }
  // Forgejo and Gitea write the same shape on arbitrary self-hosted domains, including nested
  // organisations on some installs. Only believed from a host named after them.
  const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (
    forgejo &&
    (configuredTracker === "forgejo" ||
      (configuredTracker === undefined &&
        (isHostOf(hostname, "codeberg.org") ||
          isHostOf(hostname, "forgejo.org", "forgejo") ||
          isHostOf(hostname, "gitea.com", "gitea"))))
  ) {
    return claim("forgejo", host, forgejo);
  }
  return null;
}

function claim(tracker: string, host: string, match: RegExpExecArray | null): IssueLink | null {
  const scope = match?.[1];
  const key = match?.[2];
  return scope && key && Number.isSafeInteger(Number(key)) && Number(key) > 0
    ? { tracker, host, scope: scope.toLowerCase(), key }
    : null;
}
