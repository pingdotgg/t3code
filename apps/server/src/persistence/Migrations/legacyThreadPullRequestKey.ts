import type { ThreadLinkedPullRequest, ThreadPullRequestKey } from "@t3tools/contracts";

/**
 * Frozen for migrations 050 and 064: the change request URL parsing and key normalization they
 * shipped with. Migrations are history, so they must not follow the live source control hosts.
 */

interface FrozenLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly authority?: string;
}

function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}

function isHostOf(hostname: string, apex: string, label: string): boolean {
  return hostname === apex || hostname.endsWith(`.${apex}`) || hostname.split(".").includes(label);
}

function claim(host: string, match: RegExpExecArray | null): FrozenLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

function parseChangeRequestUrl(targetUrl: string): FrozenLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (host === "git.cafe" || host === "staging.git.cafe") {
    const match = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:\/|$)/u.exec(url.pathname);
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
  const azure = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const link = claim(host, azure);
  return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
}

function normalizeThreadPullRequestKey(
  key: ThreadPullRequestKey & { readonly authority?: string },
): ThreadPullRequestKey {
  const canonical = canonicalRepositoryKey(
    `${(key.authority ?? key.host).trim().toLowerCase()}/${key.repository.trim().toLowerCase()}`,
  );
  const separator = canonical.indexOf("/");
  return {
    host: canonical.slice(0, separator),
    repository: canonical.slice(separator + 1),
    number: key.number,
  };
}

export function legacyThreadPullRequestKey(
  linked: Pick<ThreadLinkedPullRequest, "repository" | "number" | "url">,
): ThreadPullRequestKey {
  const parsed = parseChangeRequestUrl(linked.url);
  if (parsed !== null && parsed.number === linked.number) {
    const canonical = canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`);
    if (parsed.authority !== undefined || canonical.startsWith("dev.azure.com/")) {
      return normalizeThreadPullRequestKey(parsed);
    }
  }
  let host: string;
  try {
    host = new URL(linked.url).hostname;
  } catch {
    host = "unknown";
  }
  return {
    host: host.trim().toLowerCase() || "unknown",
    repository: linked.repository.trim().toLowerCase(),
    number: linked.number,
  };
}
