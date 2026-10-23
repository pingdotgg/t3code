/**
 * Only hosts where a credential is what decides the answer belong here. `objects.githubusercontent.com`
 * and the `private-user-images` links GitHub's own HTML carries are already signed and load on their
 * own, and a token does nothing for them once that signature expires.
 */

const RAW_HOST = "raw.githubusercontent.com";
const LFS_HOST = "media.githubusercontent.com";
const ATTACHMENT_PATH_PATTERN = /^\/user-attachments\/assets\/[\w-]+$/u;
const LEGACY_ATTACHMENT_PATH_PATTERN = /^\/[^/]+\/[^/]+\/assets\/\d+\/[\w-]+$/u;
const RELEASE_DOWNLOAD_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/u;
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
  if (githubReleaseAsset(source) !== null) return `https://github.com${url.pathname}`;
  const repositoryFile = REPOSITORY_FILE_PATTERN.exec(url.pathname);
  return repositoryFile
    ? `https://${RAW_HOST}/${repositoryFile[1]}/${repositoryFile[2]}/${repositoryFile[3]}`
    : null;
}

interface GitHubReleaseAsset {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
  readonly name: string;
}

export function githubReleaseAsset(source: string): GitHubReleaseAsset | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "")
    return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const match = RELEASE_DOWNLOAD_PATH_PATTERN.exec(url.pathname);
  if (match === null) return null;
  try {
    const owner = decodeURIComponent(match[1]!);
    const repo = decodeURIComponent(match[2]!);
    const tag = decodeURIComponent(match[3]!);
    const name = decodeURIComponent(match[4]!);
    if (
      [owner, repo, tag, name].some((part) => part === "." || part === "..") ||
      !/^[\w.-]+$/u.test(owner) ||
      !/^[\w.-]+$/u.test(repo) ||
      // Tags may contain "/" (git allows refs/tags/release/v1); the API lookup re-encodes it.
      /[\p{Cc}\p{Cf}\\]/u.test(tag) ||
      /[\p{Cc}\p{Cf}\\/]/u.test(name)
    )
      return null;
    return { owner, repo, tag, name };
  } catch {
    return null;
  }
}

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
