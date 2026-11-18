import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { definition } from "../shared/definition.ts";
import { isGitHubHost } from "./GitHubCredentials.ts";

export interface GitHubRepositoryLocator {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export function parseFetchRemotes(
  remotes: string,
): ReadonlyArray<{ readonly name: string; readonly url: string }> {
  // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
  return remotes
    .split("\n")
    .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)(?:\s+\[[^\]]+\])?$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!, url: match[2]! }));
}

/** gh priority: marked default, upstream/github/origin, sole remote. Null if ambiguous. */
export function selectGitHubBaseRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly host: string;
}): { readonly owner: string; readonly name: string } | null {
  const host = input.host.toLowerCase();
  const repositories = new Map<string, { readonly owner: string; readonly name: string }>();
  for (const remote of parseFetchRemotes(input.remotes)) {
    const [normalizedHost, owner, name, ...rest] = normalizeGitRemoteUrl(remote.url).split("/");
    const remoteHost =
      normalizedHost && isSshRemoteUrl(remote.url)
        ? (apiHostForSshAlias(normalizedHost) ?? normalizedHost)
        : normalizedHost;
    if (remoteHost !== host || !owner || !name || rest.length > 0) return null;
    repositories.set(remote.name, { owner, name });
  }
  const marks = input.resolved
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && repositories.has(match[1]!));
  if (marks.length > 1) return null;
  const [mark] = marks;
  if (mark) {
    if (mark[2] === "base") return repositories.get(mark[1]!) ?? null;
    const [owner, name, ...rest] = mark[2]!.toLowerCase().split("/");
    return owner && name && rest.length === 0 ? { owner, name } : null;
  }
  // gh ranks these names case-insensitively; a top-ranked tie has no defined winner.
  const score = (remoteName: string) =>
    ["origin", "github", "upstream"].indexOf(remoteName.toLowerCase()) + 1;
  const ranked = [...repositories.entries()].toSorted(
    ([left], [right]) => score(right) - score(left),
  );
  const [top, next] = ranked;
  return top !== undefined && (next === undefined || score(top[0]) > score(next[0]))
    ? top[1]
    : null;
}

/** Check GH_REPO first; host is available even without a repository. */
export function resolveGitHubRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly hostHint: string | undefined;
  readonly defaultHost: string;
}): { readonly host: string; readonly locator: GitHubRepositoryLocator | null } {
  const fetchRemotes = parseFetchRemotes(input.remotes).map((remote) => ({
    ...remote,
    host: gitHubApiHostForRemote(remote.url),
  }));
  const host =
    (input.hostHint === undefined ? undefined : apiHostForHint(input.hostHint, fetchRemotes)) ??
    fetchRemotes.find((remote) => remote.name === "origin" && remote.host !== null)?.host ??
    fetchRemotes.find((remote) => remote.host !== null)?.host ??
    input.defaultHost;
  const selected = selectGitHubBaseRepository({
    remotes: input.remotes,
    resolved: input.resolved,
    host,
  });
  if (selected !== null) return { host, locator: { host, ...selected } };
  // Match gh's host-filtered priority: upstream, github, origin, then the first remote.
  const rank = (name: string) => ["upstream", "github", "origin"].indexOf(name.toLowerCase());
  const candidates = fetchRemotes
    .filter(
      (remote) =>
        remote.host === host ||
        (remote.host === null && normalizeGitRemoteUrl(remote.url).split("/")[0] === host),
    )
    .toSorted((left, right) => {
      const l = rank(left.name);
      const r = rank(right.name);
      return (l === -1 ? 99 : l) - (r === -1 ? 99 : r);
    });
  for (const remote of candidates) {
    const [owner, name, ...rest] = normalizeGitRemoteUrl(remote.url).split("/").slice(1);
    if (owner && name && rest.length === 0) return { host, locator: { host, owner, name } };
  }
  return { host, locator: null };
}

export function parseGitHubRepositorySelector(
  selector: string,
  defaultHost: string,
): GitHubRepositoryLocator | null {
  // Like gh, a clone URL's `.git` comes off the path, before any trailing slash, query or fragment.
  const withoutGitSuffix = (path: string) => path.replace(/\.git\/*$/i, "");
  const trimmed = selector.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const [owner, name, ...rest] = withoutGitSuffix(url.pathname).split("/").filter(Boolean);
      return owner && name && rest.length === 0
        ? { host: url.host.toLowerCase(), owner, name }
        : null;
    } catch {
      return null;
    }
  }
  const parts = withoutGitSuffix(trimmed).split("/").filter(Boolean);
  if (parts.length === 2) return { host: defaultHost, owner: parts[0]!, name: parts[1]! };
  const host = parts[0]?.toLowerCase();
  if (parts.length === 3 && host !== undefined && isGitHubHost(host))
    return { host, owner: parts[1]!, name: parts[2]! };
  return null;
}

export function parsePullRequestReference(
  reference: string,
):
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "url"; readonly locator: GitHubRepositoryLocator; readonly number: number }
  | { readonly kind: "branch"; readonly headSelector: string } {
  const trimmed = reference.trim();
  const numbered = /^#?([1-9]\d*)$/.exec(trimmed);
  if (numbered) return { kind: "number", number: Number(numbered[1]) };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
      if (match) {
        return {
          kind: "url",
          locator: { host: url.host.toLowerCase(), owner: match[1]!, name: match[2]! },
          number: Number(match[3]),
        };
      }
    } catch {}
  }
  return { kind: "branch", headSelector: trimmed };
}

// An additional dot is a real DNS host, never a github.com SSH alias.
const GITHUB_DOT_COM_SSH_ALIAS = /^github\.com-[a-z0-9_-]+$/u;

function apiHostForSshAlias(host: string): string | null | undefined {
  if (!host.includes(".")) return host.includes("github") ? "github.com" : null;
  return GITHUB_DOT_COM_SSH_ALIAS.test(host) ? "github.com" : undefined;
}

/** Recognized GitHub SSH aliases use github.com for API requests. */
export function gitHubApiHostForRemote(remoteUrl: string): string | null {
  const remote = parseGitRemoteHost(remoteUrl);
  if (remote === null) return null;
  const host = new URL(`https://${remote.host}`).host.toLowerCase();
  if (isSshRemoteUrl(remoteUrl)) {
    const aliased = apiHostForSshAlias(host);
    if (aliased !== undefined) return aliased;
  }
  return definition.recognizeRemote(remote) === null ? null : host;
}

function apiHostForHint(host: string, remotes: ReadonlyArray<{ readonly url: string }>): string {
  const normalized = host.toLowerCase();
  if (GITHUB_DOT_COM_SSH_ALIAS.test(normalized)) {
    const matching = remotes.filter(
      (remote) => normalizeGitRemoteUrl(remote.url).split("/")[0] === normalized,
    );
    // A hint carries no transport; an HTTPS remote or missing evidence must not select
    // the github.com endpoint and credentials for a dotted host.
    if (matching.length === 0 || matching.some((remote) => !isSshRemoteUrl(remote.url)))
      return normalized;
  }
  return apiHostForSshAlias(normalized) ?? normalized;
}
