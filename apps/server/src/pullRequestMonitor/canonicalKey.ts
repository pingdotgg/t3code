import type { PullRequestMonitorCanonicalKey } from "@t3tools/contracts";

/** Runtime formatter kept out of schema-only `packages/contracts`. */
export function formatPullRequestMonitorCanonicalKey(key: PullRequestMonitorCanonicalKey): string {
  return `${key.provider}:${key.host}:${key.repository}#${key.number}`;
}

export function normalizeRepositoryIdentity(repository: string): string {
  return repository.trim().toLowerCase();
}

/** `https://host/owner/name/pull/123` -> `owner/name`. */
export function repositoryFromPullRequestUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const segments = new URL(url).pathname.replace(/^\/+/, "").split("/");
    const owner = segments[0];
    const name = segments[1];
    return owner && name ? `${owner}/${name}` : null;
  } catch {
    return null;
  }
}
