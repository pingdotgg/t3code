export const GITCAFE_HOSTS = ["git.cafe", "staging.git.cafe"] as const;
export type GitCafeHost = (typeof GITCAFE_HOSTS)[number];

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

export function gitCafeRepositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return REPOSITORY.test(repository) ? repository : null;
}

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
