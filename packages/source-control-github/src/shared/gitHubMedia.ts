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
/** `blob` and `raw` both address file bytes; `raw` is the one the token is honoured on. */
const REPOSITORY_FILE_PATTERN = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.*[^/])$/u;

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

function media(fetchUrl: string, kind?: "video"): SourceControlMediaUrl {
  return { fetchUrl, fileName: fileName(fetchUrl), ...(kind ? { kind } : {}) };
}

export function gitHubMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === RAW_HOST || host === LFS_HOST) {
    return media(`https://${host}${url.pathname}${url.search}`);
  }
  if (!WEB_HOSTS.has(host)) return null;
  // GitHub links an uploaded video bare, with no extension, and an image as markdown.
  if (ATTACHMENT_PATH_PATTERN.test(url.pathname)) {
    return media(`https://github.com${url.pathname}`, "video");
  }
  if (LEGACY_ATTACHMENT_PATH_PATTERN.test(url.pathname)) {
    return media(`https://github.com${url.pathname}`);
  }
  const repositoryFile = REPOSITORY_FILE_PATTERN.exec(url.pathname);
  return repositoryFile
    ? media(`https://${RAW_HOST}/${repositoryFile[1]}/${repositoryFile[2]}/${repositoryFile[3]}`)
    : null;
}
