/**
 * Only hosts where a credential is what decides the answer belong here. `objects.githubusercontent.com`
 * and the `private-user-images` links GitHub's own HTML carries are already signed and load on their
 * own, and a token does nothing for them once that signature expires.
 */

const RAW_HOST = "raw.githubusercontent.com";
const LFS_HOST = "media.githubusercontent.com";
const ATTACHMENT_PATH_PATTERN = /^\/user-attachments\/assets\/[\w-]+$/u;
const LEGACY_ATTACHMENT_PATH_PATTERN = /^\/[^/]+\/[^/]+\/assets\/\d+\/[\w-]+$/u;
/** `blob` and `raw` both address file bytes; `raw` is the one the token is honoured on. */
const REPOSITORY_FILE_PATTERN = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.*[^/])$/u;

function canonicalUrl(host: string, url: URL): string {
  return `https://${host}${url.pathname}${url.search}`;
}

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
  return repositoryFile
    ? `https://${RAW_HOST}/${repositoryFile[1]}/${repositoryFile[2]}/${repositoryFile[3]}`
    : null;
}
