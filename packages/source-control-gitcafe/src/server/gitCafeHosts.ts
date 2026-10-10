/**
 * The hosts GitCafe lives on, and how a remote URL names one of its repositories. GitCafe has no
 * self-hosted installs, so the list is fixed rather than discovered.
 *
 * @module source-control-gitcafe/server/gitCafeHosts
 */

export const GITCAFE_HOSTS = ["git.cafe", "staging.git.cafe"] as const;
export type GitCafeHost = (typeof GITCAFE_HOSTS)[number];

/** The host as GitCafe spells it, or null for any host GitCafe does not live on. */
export function gitCafeHost(host: string): GitCafeHost | null {
  const normalized = host.trim().toLowerCase();
  return GITCAFE_HOSTS.find((candidate) => candidate === normalized) ?? null;
}

export function isGitCafeHost(host: string): boolean {
  return gitCafeHost(host) !== null;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REMOTE_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/(.+)$/iu,
  /^[^@/:]+@([^/:]+):(.+)$/u,
];

/** An `owner/name` repository path, without the `.git` suffix a clone URL carries. */
export function gitCafeRepositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return REPOSITORY.test(repository) ? repository : null;
}

/** The host and `owner/name` of an https or ssh remote on a GitCafe host; null for anything else. */
export function parseGitCafeRemote(
  url: string,
): { readonly host: GitCafeHost; readonly repository: string } | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (!match?.[1] || !match[2]) continue;
    const host = gitCafeHost(match[1]);
    const repository = gitCafeRepositoryPath(match[2]);
    return host && repository ? { host, repository } : null;
  }
  return null;
}
