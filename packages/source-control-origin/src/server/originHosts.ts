export const ORIGIN_REMOTE_HOST = "origin.cursor.com";
export const ORIGIN_WEB_HOST = "cursor.com";
export const ORIGIN_API_ORIGIN = "https://api.cursor.com";
export const ORIGIN_API_BASE = `${ORIGIN_API_ORIGIN}/v1/origin`;

export function isOriginRemoteHost(host: string): boolean {
  return host.trim().toLowerCase() === ORIGIN_REMOTE_HOST;
}

export function isOriginWebHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === ORIGIN_WEB_HOST || normalized === `www.${ORIGIN_WEB_HOST}`;
}

export function isOriginServedHost(host: string): boolean {
  return isOriginRemoteHost(host) || isOriginWebHost(host);
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REMOTE_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(?:git\/)?(.+)$/iu,
  /^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/(?:git\/)?(.+)$/iu,
  /^[^@/:]+@([^/:]+):(?:git\/)?(.+)$/u,
];

export function originRepositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return REPOSITORY.test(repository) ? repository : null;
}

export function parseOriginRemote(
  url: string,
): { readonly host: typeof ORIGIN_REMOTE_HOST; readonly repository: string } | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (!match?.[1] || !match[2]) continue;
    if (!isOriginRemoteHost(match[1])) continue;
    const repository = originRepositoryPath(match[2]);
    return repository ? { host: ORIGIN_REMOTE_HOST, repository } : null;
  }
  return null;
}

export function shortBranchName(ref: string): string {
  return ref.replace(/^refs\/heads\//u, "");
}
