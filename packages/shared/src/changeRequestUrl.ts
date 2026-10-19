import type { RepositoryIdentity, ThreadLinkedPullRequest } from "@t3tools/contracts";
import { canonicalRepositoryKey } from "./sourceControl.ts";

/**
 * The two strings are what `pullRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because links are
 * matched against those. Anything else matches nothing.
 */
export interface ChangeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly authority?: string;
}

function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.split(".").includes(label);
}

export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (host === "git.cafe" || host === "staging.git.cafe") {
    const match = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  } else {
    if (isHostOf(host, "github.com", "github")) {
      const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
      if (match) return claim(host, match);
    }
    const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (forgejo) {
      const link = claim(host, forgejo);
      return link === null ? null : { ...link, authority: url.host.toLowerCase() };
    }
    const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (gitlab) return claim(host, gitlab);
    if (isHostOf(host, "bitbucket.org", "bitbucket")) {
      const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
      if (match) return claim(host, match);
    }
  }
  // Azure DevOps Server can use any hostname; its `_git` pull request route identifies it.
  const azure = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const link = claim(host, azure);
  return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

function remoteWebOrigin(host: string, remoteUrl: string | undefined): string {
  try {
    const remote = new URL(remoteUrl ?? "");
    if (
      (remote.protocol === "http:" || remote.protocol === "https:") &&
      (remote.hostname.toLowerCase() === host.toLowerCase() ||
        remote.host.toLowerCase() === host.toLowerCase())
    ) {
      return remote.origin;
    }
  } catch {
    // SSH remotes do not specify the server's web origin.
  }
  return `https://${host}`;
}

export function changeRequestUrlFor(
  kind: string | null | undefined,
  host: string,
  repository: string,
  number: number,
  remoteUrl?: string,
): string | null {
  switch (kind) {
    case "github":
      return `https://${host}/${repository}/pull/${number}`;
    case "gitcafe":
      return `https://${host}/${repository}/pulls/${number}`;
    case "forgejo":
      return `${remoteWebOrigin(host, remoteUrl)}/${repository}/pulls/${number}`;
    case "gitlab":
      return `https://${host}/${repository}/-/merge_requests/${number}`;
    case "bitbucket":
      return `https://${host}/${repository}/pull-requests/${number}`;
    case "azure-devops": {
      const [canonicalHost = host, ...path] = canonicalRepositoryKey(
        `${host}/${repository}`.toLowerCase(),
      ).split("/");
      return `${remoteWebOrigin(canonicalHost, remoteUrl)}/${path.join("/")}/pullrequest/${number}`;
    }
    default:
      return null;
  }
}

export function gitHubPullRequestBrowserUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider !== "github" || !Number.isSafeInteger(number) || number < 1) return null;
  const repositoryPath = repository.split("/");
  if (
    repositoryPath.length !== 2 ||
    repositoryPath.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }

  let origin: string | null = null;
  try {
    const remoteUrl = new URL(identity.locator.remoteUrl.trim());
    if (remoteUrl.protocol === "http:" || remoteUrl.protocol === "https:") {
      origin = remoteUrl.origin;
    }
  } catch {}
  const hostname = identity.canonicalKey.split("/")[0];
  if (origin === null && !hostname) return null;

  try {
    const url = new URL(origin ?? `https://${hostname}`);
    url.pathname = `/${repositoryPath.join("/")}/pull/${number}`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The pull-request URL a GitHub-style `#123` autolink might name. GitHub writes every bare
 * reference through `/issues/`, including pull requests, so this only builds a candidate: the
 * caller must successfully read it as a pull request before treating it as one.
 */
export function pullRequestCandidateUrlFromReferenceAutolink(targetUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !(
      url.hostname.toLowerCase() === "github.com" ||
      url.hostname.toLowerCase().endsWith(".github.com") ||
      url.hostname.toLowerCase().split(".").includes("github")
    )
  ) {
    return null;
  }
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  url.pathname = `/${match[1]}/pull/${match[2]}`;
  return url.toString();
}

export function matchesLinkedPullRequestUrl(
  linkedPullRequest: ThreadLinkedPullRequest,
  targetUrl: string,
): boolean {
  const linked = parseChangeRequestUrl(linkedPullRequest.url);
  const target = parseChangeRequestUrl(targetUrl);
  return (
    linked !== null &&
    target !== null &&
    linked.host === target.host &&
    linked.repository === target.repository &&
    linked.number === target.number &&
    linked.authority === target.authority
  );
}

export function changeRequestRepositoryUrl(targetUrl: string): string | null {
  const changeRequest = parseChangeRequestUrl(targetUrl);
  if (changeRequest === null) return null;
  const url = new URL(targetUrl);
  const repositoryPath =
    /^(.*?)\/-\/merge_requests\/\d+(?:\/|$)/iu.exec(url.pathname)?.[1] ??
    /^(.*?)(?:\/pulls?\/\d+|\/-\/merge_requests\/\d+|\/pull-requests\/\d+|\/pullrequest\/\d+)(?:\/|$)/iu.exec(
      url.pathname,
    )?.[1];
  if (!repositoryPath) return null;
  url.pathname = repositoryPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function siblingPullRequestUrl(url: string, number: number): string | null {
  const reference = parseChangeRequestUrl(url);
  if (reference === null || !Number.isSafeInteger(number) || number < 1) return null;
  const sibling = new URL(url);
  const route = /^\/(-\/merge_requests|pulls?|pull-requests|pullrequest)\/\d+(?:\/|$)/u.exec(
    sibling.pathname.slice(reference.repository.length + 1),
  )?.[1];
  if (route === undefined) return null;
  sibling.pathname = `/${reference.repository}/${route}/${number}`;
  sibling.search = "";
  sibling.hash = "";
  return sibling.toString();
}
