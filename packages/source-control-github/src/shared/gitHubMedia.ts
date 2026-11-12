import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/**
 * Only hosts where a credential is what decides the answer belong here. `objects.githubusercontent.com`
 * and the `private-user-images` links GitHub's own HTML carries are already signed and load on their
 * own, and a token does nothing for them once that signature expires.
 */
const WEB_HOSTS = new Set(["github.com", "www.github.com"]);
const RAW_HOST = "raw.githubusercontent.com";
const LFS_HOST = "media.githubusercontent.com";
export const GITHUB_CREDENTIALED_MEDIA_HOSTS: ReadonlySet<string> = new Set([
  ...WEB_HOSTS,
  RAW_HOST,
  LFS_HOST,
]);

const ATTACHMENT_PATH_PATTERN = /^\/user-attachments\/assets\/[\w-]+$/u;
const LEGACY_ATTACHMENT_PATH_PATTERN = /^\/[^/]+\/[^/]+\/assets\/\d+\/[\w-]+$/u;
const RELEASE_DOWNLOAD_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/u;
/** `blob` and `raw` both address file bytes; `raw` is the one the token is honoured on. */
const REPOSITORY_FILE_PATTERN = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.*[^/])$/u;
/** GitHub rejects 40-hex branch and tag names, and serves no SHA-256 repositories. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function fileName(fetchUrl: string): string {
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

function media(
  fetchUrl: string,
  extra: Pick<SourceControlMediaUrl, "kind" | "immutable"> = {},
): SourceControlMediaUrl {
  return { fetchUrl, fileName: fileName(fetchUrl), ...extra };
}

/** A branch or tag can move; a raw file is fixed only when read at a full commit SHA. */
function rawFile(fetchUrl: string): SourceControlMediaUrl {
  const ref = new URL(fetchUrl).pathname.split("/")[3] ?? "";
  return media(fetchUrl, COMMIT_SHA_PATTERN.test(ref) ? { immutable: true } : {});
}

export function gitHubMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === RAW_HOST) return rawFile(`https://${host}${url.pathname}${url.search}`);
  if (host === LFS_HOST) return media(`https://${host}${url.pathname}${url.search}`);
  if (!WEB_HOSTS.has(host)) return null;
  // GitHub links an uploaded video bare, with no extension, and an image as markdown.
  if (ATTACHMENT_PATH_PATTERN.test(url.pathname)) {
    return media(`https://github.com${url.pathname}`, { kind: "video", immutable: true });
  }
  if (LEGACY_ATTACHMENT_PATH_PATTERN.test(url.pathname)) {
    return media(`https://github.com${url.pathname}`, { immutable: true });
  }
  if (gitHubReleaseAsset(url) !== null) return media(`https://github.com${url.pathname}`);
  const repositoryFile = REPOSITORY_FILE_PATTERN.exec(url.pathname);
  return repositoryFile
    ? rawFile(`https://${RAW_HOST}/${repositoryFile[1]}/${repositoryFile[2]}/${repositoryFile[3]}`)
    : null;
}

export interface GitHubReleaseAsset {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
  readonly name: string;
}

/** A release download on github.com, which a private repository serves only through the API. */
export function gitHubReleaseAsset(url: URL): GitHubReleaseAsset | null {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "")
    return null;
  if (!WEB_HOSTS.has(url.hostname.toLowerCase())) return null;
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
