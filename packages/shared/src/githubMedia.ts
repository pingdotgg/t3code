/**
 * Media a pull request body points at on GitHub's own hosts. In a private repository GitHub
 * answers an unauthenticated request for one with 404 — a screenshot dropped into a description
 * becomes `github.com/user-attachments/assets/<id>`, and a file committed alongside the code
 * becomes a `raw.githubusercontent.com` path — so the renderer, which carries no GitHub session,
 * draws a broken image where the reviewer expects the evidence. The server can fetch these with
 * the `gh` credential and hand the bytes back.
 *
 * Only hosts where a credential is what decides the answer belong here. `objects.githubusercontent.com`
 * and the `private-user-images` links GitHub's own HTML carries are already signed and load on their
 * own, and a token does nothing for them once that signature expires.
 */

const RAW_HOST = "raw.githubusercontent.com";
/** Git LFS pointers resolve here, which is where an LFS-tracked screenshot's bytes live. */
const LFS_HOST = "media.githubusercontent.com";
const ATTACHMENT_PATH_PATTERN = /^\/user-attachments\/assets\/[\w-]+$/u;
/** What GitHub wrote into a body before `user-attachments`; older descriptions still carry it. */
const LEGACY_ATTACHMENT_PATH_PATTERN = /^\/[^/]+\/[^/]+\/assets\/\d+\/[\w-]+$/u;
/** `blob` and `raw` both address file bytes; `raw` is the one the token is honoured on. */
const REPOSITORY_FILE_PATTERN = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.*[^/])$/u;

/** Port, userinfo, and fragment say nothing about which bytes GitHub will serve. */
function canonicalUrl(host: string, url: URL): string {
  return `https://${host}${url.pathname}${url.search}`;
}

/**
 * The URL to fetch with a GitHub credential for `source`, or null when the source is not
 * GitHub-hosted media — those keep loading directly, exactly as they do today.
 */
export function githubMediaFetchUrl(source: string): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === RAW_HOST || host === LFS_HOST) return canonicalUrl(host, url);
  if (host !== "github.com" && host !== "www.github.com") return null;
  if (
    ATTACHMENT_PATH_PATTERN.test(url.pathname) ||
    LEGACY_ATTACHMENT_PATH_PATTERN.test(url.pathname)
  ) {
    return `https://github.com${url.pathname}`;
  }
  const repositoryFile = REPOSITORY_FILE_PATTERN.exec(url.pathname);
  // `?raw=true` is how the web UI spells "the bytes, not the page"; the raw host needs no query.
  return repositoryFile
    ? `https://${RAW_HOST}/${repositoryFile[1]}/${repositoryFile[2]}/${repositoryFile[3]}`
    : null;
}

/**
 * Whether `fetchUrl` addresses a user attachment on GitHub itself: the canonical
 * `user-attachments` form or the legacy per-repository form both redirect to the same signed
 * object store. Only the host and path decide where the bytes come from, so a query string
 * does not disqualify the URL.
 */
export function isGitHubUserAttachmentFetchUrl(fetchUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(fetchUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return false;
  return (
    ATTACHMENT_PATH_PATTERN.test(url.pathname) || LEGACY_ATTACHMENT_PATH_PATTERN.test(url.pathname)
  );
}

/**
 * Last path segment, for the signed URL's display name. A percent sequence GitHub accepts but
 * `decodeURIComponent` rejects is left encoded rather than failing the whole asset.
 */
export function githubMediaFileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "github-media";
}
