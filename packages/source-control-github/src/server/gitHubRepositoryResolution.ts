import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { parseGitRemoteHost } from "@t3tools/source-control-core/client/definition";
import { definition } from "../client/definition.ts";

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

/**
 * The repository `gh pr list` reads in a checkout, picked the way gh picks one without a prompt: the
 * remote `gh repo set-default` marked, else the first of upstream, github, origin (in any case), else
 * the only remote.
 *
 * Null whenever gh might weigh the remotes differently: a remote on another host or under an SSH alias,
 * more than one mark, or several remotes with none of those names.
 */
export function selectGitHubBaseRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly host: string;
}): { readonly owner: string; readonly name: string } | null {
  const host = input.host.toLowerCase();
  const repositories = new Map<string, { readonly owner: string; readonly name: string }>();
  for (const remote of parseFetchRemotes(input.remotes)) {
    const [remoteHost, owner, name, ...rest] = normalizeGitRemoteUrl(remote.url).split("/");
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
  // gh sorts remotes by these names, case-insensitively, and takes the first. A tie for the
  // top place has no defined winner.
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

/**
 * `host` is the API host it settled on, which a caller names when no repository was
 * found there. GH_REPO is the caller's to check first.
 */
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
    (input.hostHint === undefined ? undefined : apiHostForHint(input.hostHint)) ??
    fetchRemotes.find((remote) => remote.name === "origin" && remote.host !== null)?.host ??
    fetchRemotes.find((remote) => remote.host !== null)?.host ??
    input.defaultHost;
  const selected = selectGitHubBaseRepository({
    remotes: input.remotes,
    resolved: input.resolved,
    host,
  });
  if (selected !== null) return { host, locator: { host, ...selected } };
  // gh's own order without its prompt: upstream, github, origin, then the first remote, among
  // the ones on this host (an SSH alias counts as its API host).
  const rank = (name: string) => ["upstream", "github", "origin"].indexOf(name.toLowerCase());
  const candidates = fetchRemotes
    .filter(
      (remote) => remote.host === host || normalizeGitRemoteUrl(remote.url).split("/")[0] === host,
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
  const trimmed = selector.trim().replace(/\.git$/i, "");
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const [owner, name, ...rest] = url.pathname.split("/").filter(Boolean);
      return owner && name && rest.length === 0
        ? { host: url.host.toLowerCase(), owner, name }
        : null;
    } catch {
      return null;
    }
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 2) return { host: defaultHost, owner: parts[0]!, name: parts[1]! };
  if (parts.length === 3)
    return { host: parts[0]!.toLowerCase(), owner: parts[1]!, name: parts[2]! };
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

/**
 * An SSH alias (`git@github-work:owner/repo`) names no API host of its own; it is read
 * through `github.com`, which is what such an alias almost always stands for (issue
 * #6198).
 */
export function gitHubApiHostForRemote(remoteUrl: string): string | null {
  const remote = parseGitRemoteHost(remoteUrl);
  if (remote === null) return null;
  const host = new URL(`https://${remote.host}`).host.toLowerCase();
  if (isSshRemoteUrl(remoteUrl) && !host.includes(".")) {
    return host.includes("github") ? "github.com" : null;
  }
  return definition.recognizeRemote(remote) === null ? null : host;
}

function apiHostForHint(host: string): string {
  const normalized = host.toLowerCase();
  return !normalized.includes(".") && normalized.includes("github") ? "github.com" : normalized;
}
